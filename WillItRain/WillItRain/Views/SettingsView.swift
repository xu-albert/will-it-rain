import SwiftUI

struct SettingsView: View {
    @Binding var settings: NotificationSettings
    @Environment(\.dismiss) private var dismiss

    private let leadTimeOptions = [10, 15, 20, 30, 60]
    private let chartHourOptions = [6, 12, 24]

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

                Section("Quiet Hours") {
                    Toggle("Enable Quiet Hours", isOn: $settings.quietHoursEnabled)

                    if settings.quietHoursEnabled {
                        DatePicker("Start", selection: $settings.quietHoursStart, displayedComponents: .hourAndMinute)
                        DatePicker("End", selection: $settings.quietHoursEnd, displayedComponents: .hourAndMinute)
                    }
                }

                Section("Chart") {
                    Picker("Time Range", selection: $settings.chartHours) {
                        ForEach(chartHourOptions, id: \.self) { hours in
                            Text("\(hours) hours").tag(hours)
                        }
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
