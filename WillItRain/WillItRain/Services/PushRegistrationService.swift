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
    func registerLocation(lat: Double, lon: Double, leadTimeMinutes: Int) async {
        guard let token = UserDefaults.standard.string(forKey: "pushDeviceToken"),
              let url = URL(string: "\(baseURL)/register") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(
            RegistrationPayload(token: token, lat: lat, lon: lon, leadTimeMinutes: leadTimeMinutes)
        )

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                print("[Push] Registered with backend")
            }
        } catch {
            print("[Push] Registration failed: \(error)")
        }
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
}
