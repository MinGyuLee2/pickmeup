import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import CoreGraphics

// Audio only. The application filter excludes all other apps and the microphone stays disabled.
// Every PCM frame is written in order; timestamps are diagnostics, never splice instructions.
final class AudioOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    let url: URL
    let queue = DispatchQueue(label: "pickmeup.emulator-audio")
    var file: AVAudioFile?
    var error: String?
    var frames: Int64 = 0
    var buffers = 0
    var firstPTS: Double?
    var lastEnd: Double?
    var maxGap: Double = 0
    var rate: Double = 0
    var channels: UInt32 = 0
    init(url: URL) { self.url = url }
    func stream(_ stream: SCStream, didStopWithError error: Error) { queue.async { self.error = error.localizedDescription } }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, error == nil,
              let desc = sampleBuffer.formatDescription else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: desc)
        let count = CMSampleBufferGetNumSamples(sampleBuffer)
        guard count > 0, let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else { return }
        pcm.frameLength = AVAudioFrameCount(count)
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(count), into: pcm.mutableAudioBufferList)
        guard status == noErr else { error = "PCM copy failed: \(status)"; return }
        do {
            if file == nil {
                rate = format.sampleRate; channels = format.channelCount
                var settings = format.settings
                settings[AVLinearPCMIsNonInterleaved] = false
                file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved)
            }
            guard rate == format.sampleRate, channels == format.channelCount else { error = "Audio format changed; recording stopped rather than converting packets"; return }
            let pts = sampleBuffer.presentationTimeStamp.seconds
            if firstPTS == nil { firstPTS = pts }
            if let previous = lastEnd { maxGap = max(maxGap, abs(pts - previous)) }
            lastEnd = pts + Double(count) / rate
            try file!.write(from: pcm)
            frames += Int64(count); buffers += 1
        } catch { self.error = error.localizedDescription }
    }
}

enum CaptureError: Error { case invalidArguments, permissionRequired, targetNotFound, outputExists, failed(String) }
@main struct RecordEmulatorAudio {
    static func main() async {
        do { try await capture() }
        catch { FileHandle.standardError.write(Data("Audio capture failed: \(error)\n".utf8)); exit(1) }
    }
    static func capture() async throws {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count == 3, let pid = Int32(args[0]), let seconds = Double(args[1]), seconds > 0, seconds <= 300 else { throw CaptureError.invalidArguments }
        let url = URL(fileURLWithPath: args[2])
        guard !FileManager.default.fileExists(atPath: url.path), !FileManager.default.fileExists(atPath: url.path + ".json") else { throw CaptureError.outputExists }
        guard CGPreflightScreenCaptureAccess() else { throw CaptureError.permissionRequired }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        guard let app = content.applications.first(where: { $0.processID == pid }), let display = content.displays.first else { throw CaptureError.targetNotFound }
        let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.width = 16; config.height = 16; config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.showsCursor = false; config.capturesAudio = true; config.captureMicrophone = false
        config.excludesCurrentProcessAudio = true; config.sampleRate = 48_000; config.channelCount = 2
        let output = AudioOutput(url: url), stream = SCStream(filter: filter, configuration: config, delegate: output)
        try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: output.queue)
        let wallStart = Date().timeIntervalSince1970
        try await stream.startCapture()
        print("AUDIO_READY pid=\(pid) microphone=false videoOutput=false"); fflush(stdout)
        try await Task.sleep(for: .seconds(seconds))
        try await stream.stopCapture()
        output.queue.sync { output.file = nil }
        if let error = output.error { throw CaptureError.failed(error) }
        guard output.frames > 0 else { throw CaptureError.failed("No audio frames from target app") }
        let result: [String: Any] = ["capture": "ScreenCaptureKit application audio", "targetPID": pid,
            "microphone": false, "videoOutput": false, "wallStartEpoch": wallStart,
            "sampleRate": output.rate, "channels": output.channels, "frames": output.frames,
            "buffers": output.buffers, "durationSeconds": Double(output.frames) / output.rate,
            "maxTimestampGapSeconds": output.maxGap, "insertedFrames": 0, "droppedFrames": 0]
        try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: url.path + ".json"), options: .withoutOverwriting)
        print("AUDIO_SAVED frames=\(output.frames) inserted=0 dropped=0")
    }
}
