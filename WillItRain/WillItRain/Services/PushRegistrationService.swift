import Foundation

final class PushRegistrationService {
    static let shared = PushRegistrationService()

    // TODO: Replace with your deployed Worker URL
    private let baseURL = "https://will-it-rain.albertwxu.workers.dev"

    /// Called from AppDelegate when APNs returns a device token
    func storeToken(_ deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(hex, forKey: "pushDeviceToken")
        print("[Push] Stored device token: \(hex)")
    }

    /// Register or update location with the backend
    func registerLocation(
        lat: Double,
        lon: Double,
        leadTimeMinutes: Int,
        rainStartEnabled: Bool = true,
        rainEndEnabled: Bool = true
    ) async {
        guard let token = UserDefaults.standard.string(forKey: "pushDeviceToken"),
              let url = URL(string: "\(baseURL)/register") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(
            RegistrationPayload(
                token: token,
                lat: lat,
                lon: lon,
                leadTimeMinutes: leadTimeMinutes,
                rainStartEnabled: rainStartEnabled,
                rainEndEnabled: rainEndEnabled
            )
        )

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let http = response as? HTTPURLResponse
            if http?.statusCode == 200 {
                print("[Push] Registered with backend")
            } else {
                // The backend refuses registrations it cannot afford: 429 when
                // this network has registered too often, 503 when the service
                // is at its grid-cell coverage limit (`coverage_at_capacity`)
                // or this area already holds as many devices as it can notify
                // (`cell_at_capacity`). All are recoverable and all come with an
                // explanation in the body — including, on the 503s, that the
                // server has cleared any earlier registration for this device
                // rather than leave it alerting for a previous location. Print
                // the body verbatim, rather than letting a rejected
                // registration look like a success.
                let detail = String(data: data, encoding: .utf8) ?? "<no body>"
                print("[Push] Registration rejected (HTTP \(http?.statusCode ?? -1)): \(detail)")
            }
        } catch {
            print("[Push] Registration failed: \(error)")
        }
    }

    /// Send a Live Activity push token to the backend so it can push
    /// content-state updates (apns-push-type: liveactivity).
    func registerLiveActivityToken(_ activityToken: String) async {
        guard let token = UserDefaults.standard.string(forKey: "pushDeviceToken"),
              let url = URL(string: "\(baseURL)/register-activity") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(
            ["token": token, "activityToken": activityToken]
        )

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                print("[Push] Live Activity token registered")
            } else {
                print("[Push] Live Activity token registration returned non-200")
            }
        } catch {
            print("[Push] Live Activity token registration failed: \(error)")
        }
    }

    /// Tell the backend the current Live Activity ended.
    func unregisterLiveActivity() async {
        guard let token = UserDefaults.standard.string(forKey: "pushDeviceToken"),
              let url = URL(string: "\(baseURL)/unregister-activity") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["token": token])
        _ = try? await URLSession.shared.data(for: request)
    }

    func unregister() async {
        guard let token = UserDefaults.standard.string(forKey: "pushDeviceToken"),
              let url = URL(string: "\(baseURL)/unregister") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["token": token])

        _ = try? await URLSession.shared.data(for: request)
        UserDefaults.standard.removeObject(forKey: "pushDeviceToken")
    }
}

private struct RegistrationPayload: Encodable {
    let token: String
    let lat: Double
    let lon: Double
    let leadTimeMinutes: Int
    let rainStartEnabled: Bool
    let rainEndEnabled: Bool
}
