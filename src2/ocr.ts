/** Screen & image text: "what does this error on screen say" without retyping.
 *  Screenshot capture uses PowerShell + System.Drawing on Windows (the target
 *  platform, no native dependency); OCR runs fully local/free via tesseract.js WASM.
 *  The recognize seam is injectable so tests never download language data. */
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

export type RecognizeFn = (imagePath: string) => Promise<string>;

let recognizeImpl: RecognizeFn | null = null;

/** Tests plug in a fake here so the suite never downloads ~10MB of language data. */
export function setRecognizeForTests(fn: RecognizeFn | null): void {
  recognizeImpl = fn;
}

/** OCR an image file to text. First real run downloads the eng traineddata (cached after). */
export async function ocrImage(imagePath: string): Promise<string> {
  if (!existsSync(imagePath)) throw new Error(`${imagePath} does not exist.`);
  if (recognizeImpl) return recognizeImpl(imagePath);
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try {
    const { data } = await worker.recognize(imagePath);
    return data.text.trim();
  } finally {
    await worker.terminate();
  }
}

/** Capture the primary screen to a PNG. Windows only (PowerShell + System.Drawing). */
export async function captureScreen(): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Screen capture is available on Windows only. To read text from an existing image: `read the text in <path>`.");
  }
  const out = join(tmpdir(), `personal-agent-screen-${Date.now()}.png`);
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
    "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;",
    `$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;`,
    "$g = [System.Drawing.Graphics]::FromImage($bmp);",
    "$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size);",
    `$bmp.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    "$g.Dispose(); $bmp.Dispose();",
  ].join(" ");
  await new Promise<void>((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-Command", ps], { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message)));
      else resolve();
    });
  });
  if (!existsSync(out)) throw new Error("Screen capture produced no file.");
  return out;
}

export async function readScreenText(): Promise<string> {
  const shot = await captureScreen();
  try {
    return await ocrImage(shot);
  } finally {
    try { unlinkSync(shot); } catch { /* temp file */ }
  }
}
