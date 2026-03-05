import SwiftUI

struct BouncingBallView: View {
    @State private var offset: CGFloat = 0
    @State private var goingDown = true

    var body: some View {
        Circle()
            .fill(Color.red)
            .frame(width: 30, height: 30)
            .offset(y: offset)
            .onAppear {
                withAnimation(.easeInOut(duration: 1).repeatForever(autoreverses: true)) {
                    offset = 80
                }
            }
    }
}
