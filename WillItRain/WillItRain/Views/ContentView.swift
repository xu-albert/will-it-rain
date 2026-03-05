import SwiftUI
import Combine

enum AppError {
    case locationDenied
    case network(String)
}

enum AppState {
    case loading
    case loaded(RainForecast)
    case error(AppError)
}

struct ContentView: View {
    @StateObject private var locationService = LocationService()
    @State private var appState: AppState = .loading
    @StateObject private var settings = NotificationSettings()
    @State private var showSettings = false
    @State private var currentCondition: WeatherCondition = .clear
    @State private var debugConditionOverride: Bool = false
    @State private var tick: Date = Date()

    private let weatherService = WeatherService()
    private let uiTimer = Timer.publish(every: 15, on: .main, in: .common).autoconnect()
    @State private var weatherPoller = WeatherPoller()

    var body: some View {
        ZStack {
            // Dynamic gradient background
            gradientBackground
                .ignoresSafeArea()

            switch appState {
            case .loading:
                loadingView

            case .loaded(let forecast):
                #if DEBUG
                if debugConditionOverride {
                    debugPrecipitationOverlay
                        .ignoresSafeArea()
                } else {
                    precipitationOverlay(for: forecast)
                        .ignoresSafeArea()
                }
                #else
                precipitationOverlay(for: forecast)
                    .ignoresSafeArea()
                #endif
                loadedView(forecast)

            case .error(let appError):
                errorView(appError)
            }
        }
        #if DEBUG
        .overlay(alignment: .bottom) {
            debugConditionPicker
        }
        #endif
        .task { await fetchWeather() }
        .onReceive(uiTimer) { tick = $0 }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            if case .error(.locationDenied) = appState {
                Task { await fetchWeather() }
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(settings: settings)
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
            return [Color(red: 0.18, green: 0.42, blue: 0.78), Color(red: 0.22, green: 0.48, blue: 0.72)]
        case .cloudy:
            return [Color(red: 0.40, green: 0.47, blue: 0.58), Color(red: 0.55, green: 0.60, blue: 0.68)]
        case .raining:
            return [Color(red: 0.15, green: 0.20, blue: 0.35), Color(red: 0.22, green: 0.28, blue: 0.45)]
        case .rainingNight:
            return [Color(red: 0.10, green: 0.12, blue: 0.25), Color(red: 0.15, green: 0.18, blue: 0.30)]
        case .snowing:
            return [Color(red: 0.35, green: 0.40, blue: 0.55), Color(red: 0.40, green: 0.45, blue: 0.55)]
        case .snowingNight:
            return [Color(red: 0.18, green: 0.20, blue: 0.30), Color(red: 0.25, green: 0.28, blue: 0.38)]
        case .night:
            return [Color(red: 0.08, green: 0.06, blue: 0.18), Color(red: 0.15, green: 0.12, blue: 0.28)]
        }
    }

    // MARK: - Precipitation Overlay

    @ViewBuilder
    private func precipitationOverlay(for forecast: RainForecast) -> some View {
        let intensity: PrecipitationIntensity = forecast.dataPoints.first?.intensity ?? .moderate
        switch forecast.currentType {
        case .rain, .sleet:
            RainAnimationView(intensity: intensity)
        case .snow:
            SnowAnimationView(intensity: intensity)
        case .hail:
            HailAnimationView(intensity: intensity)
        case .none:
            EmptyView()
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

            // Status (tick forces re-evaluation every 15s)
            ZStack {
                let _ = tick
                let status = forecast.heroStatus(for: currentCondition)
                RainStatusView(title: status.title, subtitle: status.subtitle)
            }

            Spacer()

            // Charts
            RainChartView(dataPoints: forecast.dataPoints, chartHours: 12)
                .padding(.bottom, 12)

            WeeklyForecastView(days: forecast.dailySummaries, useCelsius: settings.useCelsius)
                .padding(.bottom, 20)

            // Attribution
            Link(destination: URL(string: "https://weatherkit.apple.com/legal-attribution.html")!) {
                HStack(spacing: 4) {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: 10))
                    Text("Weather")
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundColor(.white.opacity(0.6))
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
            .foregroundColor(.white.opacity(0.85))

            Spacer()

            Button {
                showSettings = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 18))
                    .foregroundColor(.white.opacity(0.85))
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
    }

    // MARK: - Error View

    private func errorView(_ appError: AppError) -> some View {
        VStack(spacing: 16) {
            switch appError {
            case .locationDenied:
                Image(systemName: "location.slash.fill")
                    .font(.system(size: 40))
                    .foregroundColor(.white.opacity(0.7))
                Text("Location Access Required")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(.white)
                Text("Will It Rain needs your location to show local weather. Please enable it in Settings.")
                    .foregroundColor(.white.opacity(0.7))
                    .font(.system(size: 15))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .foregroundColor(.white)
                .padding(.horizontal, 24)
                .padding(.vertical, 10)
                .background(Capsule().fill(.white.opacity(0.2)))

            case .network(let message):
                Image(systemName: "wifi.slash")
                    .font(.system(size: 40))
                    .foregroundColor(.white.opacity(0.7))
                Text("Connection Issue")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(.white)
                Text(message)
                    .foregroundColor(.white.opacity(0.7))
                    .font(.system(size: 15))
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
    }

    // MARK: - Data Fetching

    private func fetchWeather() async {
        // Don't show loading spinner on background refreshes
        if case .loaded = appState {} else { appState = .loading }
        do {
            let location = try await locationService.currentLocation()
            let name = await locationService.reverseGeocode(location)
            let forecast = try await weatherService.fetch(location: location, locationName: name)
            withAnimation(.easeInOut(duration: 2.0)) {
                currentCondition = forecast.currentCondition
            }
            appState = .loaded(forecast)

            NotificationService.shared.evaluateAndSchedule(forecast: forecast, settings: settings)

            let interval = forecast.nextPollInterval(leadTimeMinutes: settings.leadTime)
            print("[Weather] Next poll in \(Int(interval))s")
            weatherPoller.schedule(after: interval) {
                Task { await fetchWeather() }
            }
        } catch is LocationError {
            appState = .error(.locationDenied)
            return
        } catch {
            appState = .error(.network(error.localizedDescription))
            weatherPoller.schedule(after: 60) {
                Task { await fetchWeather() }
            }
        }
    }

    #if DEBUG
    @ViewBuilder
    private var debugPrecipitationOverlay: some View {
        switch currentCondition {
        case .raining, .rainingNight:
            RainAnimationView(intensity: .moderate)
        case .snowing, .snowingNight:
            SnowAnimationView(intensity: .moderate)
        default:
            EmptyView()
        }
    }

    private var debugConditionPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(WeatherCondition.allCases, id: \.self) { condition in
                    Button {
                        withAnimation(.easeInOut(duration: 0.5)) {
                            debugConditionOverride = true
                            currentCondition = condition
                        }
                    } label: {
                        Text(condition.debugLabel)
                            .font(.system(size: 11, weight: currentCondition == condition ? .bold : .medium))
                            .foregroundColor(currentCondition == condition ? .white : .white.opacity(0.6))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(
                                Capsule().fill(currentCondition == condition ? .white.opacity(0.3) : .white.opacity(0.1))
                            )
                    }
                }
            }
            .padding(.horizontal, 16)
        }
        .padding(.bottom, 4)
    }
    #endif

    private var timeString: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        return formatter.string(from: Date())
    }
}

// Make WeatherCondition Equatable for animation value
extension WeatherCondition: Equatable {}

private class WeatherPoller {
    private var workItem: DispatchWorkItem?

    func schedule(after interval: TimeInterval, block: @escaping () -> Void) {
        workItem?.cancel()
        let item = DispatchWorkItem(block: block)
        workItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + interval, execute: item)
    }
}
