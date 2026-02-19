import SwiftUI

enum AppState {
    case loading
    case loaded(RainForecast)
    case error(String)
}

struct ContentView: View {
    @StateObject private var locationService = LocationService()
    @State private var appState: AppState = .loading
    @State private var settings = NotificationSettings.load()
    @State private var showSettings = false
    @State private var currentCondition: WeatherCondition = .clear

    private let weatherService = WeatherService()

    var body: some View {
        ZStack {
            // Dynamic gradient background
            gradientBackground
                .ignoresSafeArea()
                .animation(.easeInOut(duration: 2.0), value: currentCondition)

            switch appState {
            case .loading:
                loadingView

            case .loaded(let forecast):
                loadedView(forecast)

            case .error(let message):
                errorView(message)
            }
        }
        .task { await fetchWeather() }
        .sheet(isPresented: $showSettings) {
            SettingsView(settings: $settings)
                .presentationDetents([.medium])
        }
    }

    // MARK: - Gradient Background

    @ViewBuilder
    private var gradientBackground: some View {
        LinearGradient(
            colors: gradientColors(for: currentCondition),
            startPoint: .top,
            endPoint: .bottom
        )
    }

    private func gradientColors(for condition: WeatherCondition) -> [Color] {
        switch condition {
        case .clear:
            return [Color(red: 0.30, green: 0.65, blue: 0.95), Color(red: 0.55, green: 0.82, blue: 1.0)]
        case .cloudy:
            return [Color(red: 0.40, green: 0.47, blue: 0.58), Color(red: 0.55, green: 0.60, blue: 0.68)]
        case .raining:
            return [Color(red: 0.15, green: 0.20, blue: 0.35), Color(red: 0.22, green: 0.28, blue: 0.45)]
        case .snowing:
            return [Color(red: 0.60, green: 0.68, blue: 0.78), Color(red: 0.75, green: 0.80, blue: 0.88)]
        case .night:
            return [Color(red: 0.08, green: 0.06, blue: 0.18), Color(red: 0.15, green: 0.12, blue: 0.28)]
        }
    }

    // MARK: - Loading View

    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .tint(.white)
                .scaleEffect(1.2)
            Text("Checking the sky...")
                .foregroundColor(.white.opacity(0.8))
                .font(.system(size: 16, weight: .medium))
        }
    }

    // MARK: - Loaded View

    @ViewBuilder
    private func loadedView(_ forecast: RainForecast) -> some View {
        VStack(spacing: 0) {
            // Top bar
            topBar(forecast: forecast)

            Spacer()

            // Precipitation animation
            ZStack {
                precipitationAnimation(forecast: forecast)
                    .frame(height: 200)

                let status = forecast.heroStatus
                RainStatusView(title: status.title, subtitle: status.subtitle)
            }

            Spacer()

            // Chart
            RainChartView(dataPoints: forecast.dataPoints, chartHours: settings.chartHours)
                .padding(.bottom, 20)

            // Attribution
            Link(destination: URL(string: "https://weatherkit.apple.com/legal-attribution.html")!) {
                HStack(spacing: 4) {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: 10))
                    Text("Weather")
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundColor(.white.opacity(0.4))
            }
            .padding(.bottom, 16)
        }
    }

    private func topBar(forecast: RainForecast) -> some View {
        HStack {
            HStack(spacing: 6) {
                Text(forecast.locationName)
                    .font(.system(size: 15, weight: .medium))
                Text("\u{00B7}")
                Text(timeString)
                    .font(.system(size: 15, weight: .regular))
            }
            .foregroundColor(.white.opacity(0.7))

            Spacer()

            Button {
                showSettings = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 18))
                    .foregroundColor(.white.opacity(0.7))
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
    }

    @ViewBuilder
    private func precipitationAnimation(forecast: RainForecast) -> some View {
        if let current = forecast.currentPrecipitationPeriod {
            let intensity = current.peakIntensity
            switch current.type {
            case .snow:
                SnowAnimationView(intensity: intensity)
            case .hail:
                HailAnimationView(intensity: intensity)
            case .rain, .sleet:
                RainAnimationView(intensity: intensity)
            case .none:
                EmptyView()
            }
        }
    }

    // MARK: - Error View

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 40))
                .foregroundColor(.white.opacity(0.7))
            Text(message)
                .foregroundColor(.white.opacity(0.8))
                .font(.system(size: 16))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Button("Try Again") {
                Task { await fetchWeather() }
            }
            .foregroundColor(.white)
            .padding(.horizontal, 24)
            .padding(.vertical, 10)
            .background(Capsule().fill(.white.opacity(0.2)))
        }
    }

    // MARK: - Data Fetching

    private func fetchWeather() async {
        appState = .loading
        do {
            let location = try await locationService.currentLocation()
            let name = await locationService.reverseGeocode(location)
            let forecast = try await weatherService.fetch(location: location, locationName: name)
            currentCondition = forecast.currentCondition
            appState = .loaded(forecast)

            var settings = self.settings
            NotificationService.shared.evaluateAndSchedule(forecast: forecast, settings: &settings)
            self.settings = settings
        } catch {
            appState = .error("Unable to load weather data.\n\(error.localizedDescription)")
        }
    }

    private var timeString: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        return formatter.string(from: Date())
    }
}

// Make WeatherCondition Equatable for animation value
extension WeatherCondition: Equatable {}
