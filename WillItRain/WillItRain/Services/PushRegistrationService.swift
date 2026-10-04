import CoreLocation
import Foundation

@MainActor
final class PushRegistrationService {
    static let shared = PushRegistrationService()

    enum RegistrationResult: Equatable {
        case registered
        case deferred(retryAfterSeconds: Int)
        case rejected
        case unavailable
    }

    private static let deviceTokenKey = "pushDeviceToken"
    private static let remoteRegistrationActiveKey = "remoteRegistrationActive"
    private static let pendingRegistrationKey = "pendingRegistration"

    private let baseURL: URL
    private let defaults: UserDefaults
    private let session: URLSession
    private let now: () -> Date
    private let scheduleReplay: @MainActor (Date) -> Void
    private let log: (String) -> Void
    private var retryTask: Task<Void, Never>?
    private var registrationChain: Task<Void, Never>?

    init(
        baseURL: URL = URL(string: "https://will-it-rain.albertwxu.workers.dev")!,
        defaults: UserDefaults = .standard,
        session: URLSession = .shared,
        now: @escaping () -> Date = Date.init,
        scheduleReplay: @escaping @MainActor (Date) -> Void = { BackgroundRefresh.schedule(at: $0) },
        log: @escaping (String) -> Void = { print($0) }
    ) {
        self.baseURL = baseURL
        self.defaults = defaults
        self.session = session
        self.now = now
        self.scheduleReplay = scheduleReplay
        self.log = log
    }

    /// Called from AppDelegate when APNs returns a device token
    func storeToken(_ deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        if defaults.string(forKey: Self.deviceTokenKey) != hex {
            defaults.set(false, forKey: Self.remoteRegistrationActiveKey)
            defaults.removeObject(forKey: Self.pendingRegistrationKey)
        }
        defaults.set(hex, forKey: Self.deviceTokenKey)
        log("[Push] Stored device token")
    }

    /// Whether APNs has handed us a device token yet.
    ///
    /// Every call below bails without one, so a caller that would have to do work
    /// of its own first — a CoreLocation fix, say — can check this and skip it.
    var hasStoredToken: Bool {
        defaults.string(forKey: Self.deviceTokenKey) != nil
    }

    /// True only after this exact APNs token received a confirmed registration.
    /// While true, the Worker is the sole ordinary-alert engine and the app's
    /// local evaluator is an explicit fallback rather than a second sender.
    var isRemoteRegistrationActive: Bool {
        defaults.bool(forKey: Self.remoteRegistrationActiveKey)
    }

    /// When the registration the Worker has not yet confirmed may be sent
    /// again, if one is waiting.
    var pendingRetryDate: Date? {
        pendingRegistration?.retryAt
    }

    private var pendingRegistration: PendingRegistration? {
        defaults.data(forKey: Self.pendingRegistrationKey)
            .flatMap { try? JSONDecoder().decode(PendingRegistration.self, from: $0) }
    }

    /// Sends the waiting registration once its retry time has come. Called at
    /// launch and from the background refresh as well as by the in-process
    /// timer, so a settings change made just before the app was suspended still
    /// reaches the Worker. Returns nil when nothing is waiting.
    @discardableResult
    func replayPendingRegistration() async -> RegistrationResult? {
        await serialized { [self] in
            guard let pending = pendingRegistration else { return nil }
            let wait = pending.retryAt.timeIntervalSince(now())
            guard wait <= 0 else {
                scheduleRetry(after: wait)
                scheduleReplay(pending.retryAt)
                return .deferred(retryAfterSeconds: Int(wait.rounded(.up)))
            }
            return await send(pending.payload)
        }
    }

    /// Register or update this device's location and alert settings — the form
    /// every caller has in hand. Adding a field to the payload means changing this
    /// one place, not each caller.
    @discardableResult
    func registerLocation(
        _ location: CLLocation,
        settings: NotificationSettings
    ) async -> RegistrationResult {
        let remote = settings.remoteAlertSettings
        return await registerLocation(
            lat: location.coordinate.latitude,
            lon: location.coordinate.longitude,
            remoteSettings: remote
        )
    }

    /// Register or update location with the backend
    @discardableResult
    func registerLocation(
        lat: Double,
        lon: Double,
        leadTimeMinutes: Int,
        rainStartEnabled: Bool = true,
        rainEndEnabled: Bool = true,
        quietHoursEnabled: Bool = false,
        quietHoursStartMinutes: Int = 22 * 60,
        quietHoursEndMinutes: Int = 7 * 60,
        timeZoneIdentifier: String = TimeZone.autoupdatingCurrent.identifier
    ) async -> RegistrationResult {
        await registerLocation(
            lat: lat,
            lon: lon,
            remoteSettings: RemoteAlertSettings(
                leadTimeMinutes: leadTimeMinutes,
                rainStartEnabled: rainStartEnabled,
                rainEndEnabled: rainEndEnabled,
                quietHoursEnabled: quietHoursEnabled,
                quietHoursStartMinutes: quietHoursStartMinutes,
                quietHoursEndMinutes: quietHoursEndMinutes,
                timeZoneIdentifier: timeZoneIdentifier
            )
        )
    }

    private func registerLocation(
        lat: Double,
        lon: Double,
        remoteSettings: RemoteAlertSettings
    ) async -> RegistrationResult {
        retryTask?.cancel()
        retryTask = nil
        guard let token = defaults.string(forKey: Self.deviceTokenKey) else { return .unavailable }
        let payload = RegistrationPayload(
            token: token,
            lat: lat,
            lon: lon,
            leadTimeMinutes: remoteSettings.leadTimeMinutes,
            rainStartEnabled: remoteSettings.rainStartEnabled,
            rainEndEnabled: remoteSettings.rainEndEnabled,
            quietHoursEnabled: remoteSettings.quietHoursEnabled,
            quietHoursStartMinutes: remoteSettings.quietHoursStartMinutes,
            quietHoursEndMinutes: remoteSettings.quietHoursEndMinutes,
            timeZoneIdentifier: remoteSettings.timeZoneIdentifier
        )
        savePendingRegistration(payload, retryAt: pendingRegistration?.retryAt ?? now())
        return await serialized { [self] in await send(payload) }
    }

    /// Registrations reach the Worker one at a time and in the order they were
    /// made, and a replay reads what is waiting only when its turn comes — so an
    /// older payload can never land after a newer one, or be left waiting over it.
    private func serialized<T: Sendable>(_ work: @escaping () async -> T) async -> T {
        let previous = registrationChain
        let current = Task {
            _ = await previous?.value
            return await work()
        }
        registrationChain = Task { _ = await current.value }
        return await current.value
    }

    private func send(_ payload: RegistrationPayload) async -> RegistrationResult {
        let url = baseURL.appendingPathComponent("register")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(payload)

        do {
            let (data, response) = try await session.data(for: request)
            let http = response as? HTTPURLResponse
            if http?.statusCode == 200 {
                defaults.set(true, forKey: Self.remoteRegistrationActiveKey)
                if pendingRegistration?.payload == payload {
                    defaults.removeObject(forKey: Self.pendingRegistrationKey)
                }
                retryTask = nil
                log("[Push] Registered with backend")
                return .registered
            } else if let status = http?.statusCode, status == 202 || status == 429,
                      let deferred = try? JSONDecoder().decode(DeferredRegistration.self, from: data) {
                // 202: a same-cell settings change inside the Worker's rewrite
                // cooldown. 429: this network has registered too often. Both
                // say when to come back, and that becomes the waiting
                // payload's retry time.
                let delay = max(0, deferred.retryAfterSeconds)
                let retryAt = now().addingTimeInterval(TimeInterval(delay))
                if pendingRegistration?.payload == payload {
                    savePendingRegistration(payload, retryAt: retryAt)
                }
                scheduleRetry(after: TimeInterval(delay))
                scheduleReplay(retryAt)
                log("[Push] Registration deferred for \(delay)s (HTTP \(status))")
                return .deferred(retryAfterSeconds: delay)
            } else {
                // The backend refuses registrations it cannot afford: three
                // distinct 503s — `coverage_at_capacity` (at its grid-cell limit),
                // `cell_at_capacity` (this area already holds as many devices
                // as it can notify), and `storage_unavailable` (KV threw while
                // reading the existing record). All are recoverable and all
                // come with an explanation in the body. The two capacity
                // refusals also clear any earlier registration for this device,
                // rather than leave it alerting for a previous location;
                // `storage_unavailable` changes nothing at all. Print the body
                // verbatim, rather than letting a rejected registration look
                // like a success.
                let detail = String(data: data, encoding: .utf8) ?? "<no body>"
                if let rejected = try? JSONDecoder().decode(RejectedRegistration.self, from: data),
                   rejected.code == "coverage_at_capacity" || rejected.code == "cell_at_capacity" {
                    defaults.set(false, forKey: Self.remoteRegistrationActiveKey)
                }
                log("[Push] Registration rejected (HTTP \(http?.statusCode ?? -1)): \(detail)")
                return .rejected
            }
        } catch {
            log("[Push] Registration failed: \(error)")
            return .unavailable
        }
    }

    private func savePendingRegistration(_ payload: RegistrationPayload, retryAt: Date) {
        guard let encoded = try? JSONEncoder().encode(PendingRegistration(payload: payload, retryAt: retryAt)) else { return }
        defaults.set(encoded, forKey: Self.pendingRegistrationKey)
    }

    private func scheduleRetry(after seconds: TimeInterval) {
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(seconds))
            } catch {
                return
            }
            guard !Task.isCancelled, let self else { return }
            await self.replayPendingRegistration()
        }
    }

    /// Send a Live Activity push token to the backend so it can push
    /// content-state updates (apns-push-type: liveactivity).
    func registerLiveActivityToken(_ activityToken: String) async {
        guard let token = defaults.string(forKey: Self.deviceTokenKey) else { return }
        let url = baseURL.appendingPathComponent("register-activity")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(
            ["token": token, "activityToken": activityToken]
        )

        do {
            let (_, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                log("[Push] Live Activity token registered")
            } else {
                log("[Push] Live Activity token registration returned non-200")
            }
        } catch {
            log("[Push] Live Activity token registration failed: \(error)")
        }
    }

    /// Tell the backend the current Live Activity ended.
    func unregisterLiveActivity() async {
        guard let token = defaults.string(forKey: Self.deviceTokenKey) else { return }
        let url = baseURL.appendingPathComponent("unregister-activity")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["token": token])
        _ = try? await session.data(for: request)
    }

    func unregister() async {
        guard let token = defaults.string(forKey: Self.deviceTokenKey) else { return }
        let url = baseURL.appendingPathComponent("unregister")

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["token": token])

        _ = try? await session.data(for: request)
        defaults.removeObject(forKey: Self.deviceTokenKey)
        defaults.set(false, forKey: Self.remoteRegistrationActiveKey)
        defaults.removeObject(forKey: Self.pendingRegistrationKey)
    }
}

struct RegistrationPayload: Codable, Equatable {
    let token: String
    let lat: Double
    let lon: Double
    let leadTimeMinutes: Int
    let rainStartEnabled: Bool
    let rainEndEnabled: Bool
    let quietHoursEnabled: Bool
    let quietHoursStartMinutes: Int
    let quietHoursEndMinutes: Int
    let timeZoneIdentifier: String
}

/// The newest registration the Worker has not confirmed. It is saved before it
/// is first sent and removed only by a 200 for that same payload, so a
/// suspension, a dropped connection or a refusal all leave it for the replay.
private struct PendingRegistration: Codable {
    let payload: RegistrationPayload
    let retryAt: Date
}

private struct DeferredRegistration: Decodable {
    let retryAfterSeconds: Int
}

private struct RejectedRegistration: Decodable {
    let code: String
}
