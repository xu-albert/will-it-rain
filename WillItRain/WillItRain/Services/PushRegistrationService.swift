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

    private let baseURL: URL
    private let defaults: UserDefaults
    private let session: URLSession
    private let log: (String) -> Void
    private var retryTask: Task<Void, Never>?

    init(
        baseURL: URL = URL(string: "https://will-it-rain.albertwxu.workers.dev")!,
        defaults: UserDefaults = .standard,
        session: URLSession = .shared,
        log: @escaping (String) -> Void = { print($0) }
    ) {
        self.baseURL = baseURL
        self.defaults = defaults
        self.session = session
        self.log = log
    }

    /// Called from AppDelegate when APNs returns a device token
    func storeToken(_ deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        if defaults.string(forKey: Self.deviceTokenKey) != hex {
            defaults.set(false, forKey: Self.remoteRegistrationActiveKey)
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
        return await submit(payload)
    }

    private func submit(_ payload: RegistrationPayload) async -> RegistrationResult {
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
                retryTask = nil
                log("[Push] Registered with backend")
                return .registered
            } else if http?.statusCode == 202,
                      let deferred = try? JSONDecoder().decode(DeferredRegistration.self, from: data) {
                let delay = max(0, deferred.retryAfterSeconds)
                scheduleRetry(payload, after: delay)
                log("[Push] Registration deferred for \(delay)s")
                return .deferred(retryAfterSeconds: delay)
            } else {
                // The backend refuses registrations it cannot afford: 429 when
                // this network has registered too often, and three distinct
                // 503s — `coverage_at_capacity` (at its grid-cell limit),
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

    private func scheduleRetry(_ payload: RegistrationPayload, after seconds: Int) {
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(seconds))
            } catch {
                return
            }
            guard !Task.isCancelled, let self else { return }
            _ = await self.submit(payload)
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

private struct DeferredRegistration: Decodable {
    let retryAfterSeconds: Int
}

private struct RejectedRegistration: Decodable {
    let code: String
}
