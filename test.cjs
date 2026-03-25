const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.error('PAGE ERROR:', err.message));

  await page.goto('http://127.0.0.1:8080');

  await page.type('#player-name-input', 'Test Admin');
  await page.type('#room-code-input', 'I35S00');
  
  // Use label click
  await page.click('label.facilitator-toggle');

  console.log('Clicked toggle. Now joining...');
  await page.click('#join-room-btn');

  // Wait 2 seconds to see if it routes or crashes
  await new Promise(r => setTimeout(r, 2000));

  await browser.close();
})();
