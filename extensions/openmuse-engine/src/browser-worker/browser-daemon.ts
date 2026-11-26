import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium, type BrowserContext, type Page } from "playwright-core";

export type BrowserActionParams = {
  profileId?: string;
  url?: string;
  selector?: string;
  text?: string;
  script?: string;
};

export class BrowserDaemon {
  private baseProfileDir: string;
  private contexts: Map<string, BrowserContext> = new Map();
  private activePages: Map<string, Page> = new Map();
  private chromeExecutablePath: string | null = null;

  constructor(baseProfileDir?: string) {
    this.baseProfileDir =
      baseProfileDir ||
      path.join(os.homedir(), ".friday", "openmuse", "browser_profiles");

    if (!fs.existsSync(this.baseProfileDir)) {
      fs.mkdirSync(this.baseProfileDir, { recursive: true });
    }

    this.chromeExecutablePath = this.detectExecutablePath();
  }

  private detectExecutablePath(): string | null {
    const candidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/snap/bin/chromium",
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  private async getContext(profileId: string = "default"): Promise<{ context: BrowserContext; page: Page }> {
    let context = this.contexts.get(profileId);
    let page = this.activePages.get(profileId);

    if (!context || !page || page.isClosed()) {
      const profilePath = path.join(this.baseProfileDir, profileId);
      if (!fs.existsSync(profilePath)) {
        fs.mkdirSync(profilePath, { recursive: true });
      }

      const launchOptions: any = {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      };

      if (this.chromeExecutablePath) {
        launchOptions.executablePath = this.chromeExecutablePath;
      }

      context = await chromium.launchPersistentContext(profilePath, launchOptions);
      this.contexts.set(profileId, context);

      const pages = context.pages();
      page = pages.length > 0 ? pages[0] : await context.newPage();
      this.activePages.set(profileId, page);
    }

    return { context, page };
  }

  public async navigate(url: string, profileId: string = "default"): Promise<{ title: string; url: string; contentSnippet: string }> {
    const { page } = await this.getContext(profileId);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    const title = await page.title();
    const currentUrl = page.url();
    const bodyText = await page.innerText("body").catch(() => "");
    const contentSnippet = bodyText.slice(0, 1500).replace(/\s+/g, " ").trim();

    return { title, url: currentUrl, contentSnippet };
  }

  public async snapshot(profileId: string = "default"): Promise<{ title: string; url: string; text: string }> {
    const { page } = await this.getContext(profileId);
    const title = await page.title();
    const url = page.url();
    const text = await page.innerText("body").catch(() => "");
    return { title, url, text: text.slice(0, 4000) };
  }

  public async click(selector: string, profileId: string = "default"): Promise<{ success: boolean; url: string }> {
    const { page } = await this.getContext(profileId);
    await page.click(selector, { timeout: 10000 });
    return { success: true, url: page.url() };
  }

  public async fill(selector: string, text: string, profileId: string = "default"): Promise<{ success: boolean }> {
    const { page } = await this.getContext(profileId);
    await page.fill(selector, text, { timeout: 10000 });
    return { success: true };
  }

  public async screenshot(profileId: string = "default"): Promise<{ base64Png: string; path?: string }> {
    const { page } = await this.getContext(profileId);
    const buffer = await page.screenshot({ fullPage: false });
    const screenshotDir = path.join(this.baseProfileDir, "screenshots");
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }
    const filename = `shot-${profileId}-${Date.now()}.png`;
    const fullPath = path.join(screenshotDir, filename);
    await fs.promises.writeFile(fullPath, buffer);

    return {
      base64Png: buffer.toString("base64"),
      path: fullPath,
    };
  }

  public async evaluate(script: string, profileId: string = "default"): Promise<unknown> {
    const { page } = await this.getContext(profileId);
    return await page.evaluate(script);
  }

  public async closeProfile(profileId: string = "default"): Promise<void> {
    const context = this.contexts.get(profileId);
    if (context) {
      await context.close().catch(() => {});
      this.contexts.delete(profileId);
      this.activePages.delete(profileId);
    }
  }

  public async closeAll(): Promise<void> {
    for (const [profileId, context] of this.contexts) {
      await context.close().catch(() => {});
      this.contexts.delete(profileId);
      this.activePages.delete(profileId);
    }
  }
}
