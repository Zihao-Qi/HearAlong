// Checks must opt into a disposable browser, never discover the user's installation.
export function testBrowser(): string {
  const executable = process.env.MEETING_TEST_CHROME;
  if (!executable) throw new Error('Set MEETING_TEST_CHROME to a disposable test Chromium executable. The user\'s browser is never used.');
  return executable;
}
