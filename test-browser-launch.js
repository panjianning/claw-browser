#!/usr/bin/env node

// Test browser launching functionality
import { BrowserManager } from './dist/cdp/browser.js';

async function testLaunch() {
  console.log('Testing browser launch...\n');

  let browser;
  try {
    // Launch browser in headless mode
    console.log('[1/4] Launching Chrome in headless mode...');
    browser = await BrowserManager.launch({
      headless: true,
      viewportSize: { width: 1280, height: 720 },
    });
    console.log('✓ Browser launched successfully');
    console.log(`  CDP URL: ${browser.getCdpUrl()}\n`);

    // Navigate to a page
    console.log('[2/4] Navigating to example.com...');
    const navResult = await browser.navigate('https://example.com');
    console.log('✓ Navigation successful');
    console.log(`  URL: ${navResult.url}`);
    console.log(`  Title: ${navResult.title}\n`);

    // Check if we have pages
    console.log('[3/4] Checking page management...');
    const pages = browser.getPages();
    console.log(`✓ Found ${pages.length} page(s)`);
    const activePage = browser.getActivePage();
    if (activePage) {
      console.log(`  Active page: ${activePage.title || activePage.url}\n`);
    }

    // Test connection alive
    console.log('[4/4] Testing connection...');
    const isAlive = await browser.isConnectionAlive();
    console.log(isAlive ? '✓ Connection is alive\n' : '✗ Connection is dead\n');

    console.log('All tests passed! ✓');
  } catch (err) {
    console.error('\n✗ Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    if (browser) {
      console.log('\nClosing browser...');
      await browser.close();
      console.log('✓ Browser closed');
    }
  }
}

testLaunch();
