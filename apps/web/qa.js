const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  console.log('Iniciando Chromium interno para QA...');
  const browser = await puppeteer.launch({ 
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  
  // Set viewport to a standard desktop size
  await page.setViewport({ width: 1440, height: 900 });

  const artifactDir = 'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\308f64ef-e2a2-42d6-9744-8a8260b07a98';

  console.log('Navegando para Landing Page...');
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });
  
  // Screenshot Hero
  await page.screenshot({ path: `${artifactDir}\\qa-hero.png` });
  console.log('✅ Screenshot do Hero capturado');

  // Scroll to Anatomy and screenshot
  await page.evaluate(() => { window.scrollBy(0, 800); });
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: `${artifactDir}\\qa-anatomy.png` });
  console.log('✅ Screenshot da Anatomia capturado');

  // Scroll to Pricing and screenshot
  await page.evaluate(() => { window.scrollBy(0, 800); });
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: `${artifactDir}\\qa-pricing.png` });
  console.log('✅ Screenshot de Preços capturado');

  // Navigate to Setup
  console.log('Navegando para Setup...');
  await page.goto('http://localhost:3000/setup', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: `${artifactDir}\\qa-setup.png` });
  console.log('✅ Screenshot do Setup capturado');

  // Navigate to Dashboard
  console.log('Navegando para Dashboard...');
  await page.goto('http://localhost:3000/painel', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: `${artifactDir}\\qa-dashboard.png` });
  console.log('✅ Screenshot do Dashboard capturado');

  await browser.close();
  console.log('QA Automático concluído com sucesso!');
})();
