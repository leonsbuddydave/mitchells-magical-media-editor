// Looks up a place name with Apple Maps and prints the matches as JSON.
import Foundation
import MapKit

func finish(_ payload: [String: Any]) -> Never {
  let data = try! JSONSerialization.data(withJSONObject: payload)
  FileHandle.standardOutput.write(data)
  exit(0)
}

guard CommandLine.arguments.count == 2 else {
  finish(["error": "Expected one search term."])
}

DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
  finish(["error": "The lookup timed out."])
}

Task { @MainActor in
  let request = MKLocalSearch.Request()
  request.naturalLanguageQuery = CommandLine.arguments[1]
  do {
    let response = try await MKLocalSearch(request: request).start()
    let matches: [[String: Any]] = response.mapItems.prefix(5).map { item in
      [
        "name": item.name ?? "",
        "address": item.placemark.title ?? "",
        "latitude": item.placemark.coordinate.latitude,
        "longitude": item.placemark.coordinate.longitude,
        "timeZone": item.timeZone?.identifier ?? NSNull(),
      ]
    }
    finish(["matches": matches])
  } catch let error as MKError where error.code == .placemarkNotFound {
    finish(["matches": [] as [Any]])
  } catch {
    finish(["error": error.localizedDescription])
  }
}

RunLoop.main.run()
