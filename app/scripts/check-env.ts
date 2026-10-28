// Browser-side safety boundary. Standalone checks are as isolated as checks launched by the runner.
import './check-isolation.ts';
import { chromium, type BrowserContext, type LaunchOptions } from 'playwright-core';
import { testBrowser } from './test-browser.ts';
export { piPackages } from './check-isolation.ts';

testBrowser();
const args = ['--disable-background-networking', '--disable-component-update', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'];
const guard = async (context: BrowserContext) => {
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  return context;
};
const safeOptions = (options?: LaunchOptions): LaunchOptions => ({ ...options, executablePath: testBrowser(), headless: true, args: [...args, ...options?.args ?? []] });
const launch = chromium.launch.bind(chromium);
chromium.launch = async options => {
  const browser = await launch(safeOptions(options));
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async options => guard(await newContext(options));
  return browser;
};
const persistent = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = async (profile, options) => guard(await persistent(profile, { ...options, ...safeOptions(options) }));
