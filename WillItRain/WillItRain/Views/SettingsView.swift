import SwiftUI

struct SettingsView: View {
    @ObservedObject var settings: NotificationSettings
    @Environment(\.dismiss) private var dismiss

    private let leadTimeOptions = [10, 15, 20, 30, 60]

    var body: some View {
        NavigationView {
            Form {
                Section("Notifications") {
                    Picker("Lead Time", selection: $settings.leadTime) {
                        ForEach(leadTimeOptions, id: \.self) { minutes in
                            Text("\(minutes) min").tag(minutes)
                        }
                    }

                    Toggle("Rain Starting", isOn: $settings.rainStartEnabled)
                    Toggle("Rain Ending", isOn: $settings.rainEndEnabled)
                }

                Section("Temperature") {
                    Toggle("Use Celsius", isOn: $settings.useCelsius)
                }

                Section("Quiet Hours") {
                    Toggle("Enable Quiet Hours", isOn: $settings.quietHoursEnabled)

                    if settings.quietHoursEnabled {
                        DatePicker("Start", selection: $settings.quietHoursStart, displayedComponents: .hourAndMinute)
                        DatePicker("End", selection: $settings.quietHoursEnd, displayedComponents: .hourAndMinute)
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
