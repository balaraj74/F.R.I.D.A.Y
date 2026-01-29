package bot.molt.android.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class FRIDAYProtocolConstantsTest {
  @Test
  fun canvasCommandsUseStableStrings() {
    assertEquals("canvas.present", FRIDAYCanvasCommand.Present.rawValue)
    assertEquals("canvas.hide", FRIDAYCanvasCommand.Hide.rawValue)
    assertEquals("canvas.navigate", FRIDAYCanvasCommand.Navigate.rawValue)
    assertEquals("canvas.eval", FRIDAYCanvasCommand.Eval.rawValue)
    assertEquals("canvas.snapshot", FRIDAYCanvasCommand.Snapshot.rawValue)
  }

  @Test
  fun a2uiCommandsUseStableStrings() {
    assertEquals("canvas.a2ui.push", FRIDAYCanvasA2UICommand.Push.rawValue)
    assertEquals("canvas.a2ui.pushJSONL", FRIDAYCanvasA2UICommand.PushJSONL.rawValue)
    assertEquals("canvas.a2ui.reset", FRIDAYCanvasA2UICommand.Reset.rawValue)
  }

  @Test
  fun capabilitiesUseStableStrings() {
    assertEquals("canvas", FRIDAYCapability.Canvas.rawValue)
    assertEquals("camera", FRIDAYCapability.Camera.rawValue)
    assertEquals("screen", FRIDAYCapability.Screen.rawValue)
    assertEquals("voiceWake", FRIDAYCapability.VoiceWake.rawValue)
  }

  @Test
  fun screenCommandsUseStableStrings() {
    assertEquals("screen.record", FRIDAYScreenCommand.Record.rawValue)
  }
}
