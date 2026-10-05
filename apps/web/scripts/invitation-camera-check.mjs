/** 用 Chrome 的测试摄像头播放实际二维码视频，验证真实 getUserMedia → 解码 → 填入，不模拟解码结果。 */
import { chromium } from 'playwright';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = path.join(ROOT, 'docs/ui-preview');
const BASE = 'http://localhost:5173';
const FIXTURE_CODE = 'ABCDEFGHJKMN';
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'club-camera-qa-'));
const source = path.join(TEMP, 'invitation.png');
const video = path.join(TEMP, 'invitation.y4m');
const report = { generatedAt: new Date().toISOString(), browser: '',
  dataScope: '实际 Chrome getUserMedia 使用明确的测试摄像头视频；真实 QR 解码，邀请码仅为未签发格式样例，不进行注册。不是物理手机摄像头验收。',
  screenshots: [], checks: [], errors: [] };
const record = (condition, description) => { assert.ok(condition, description); report.checks.push(description); };
const save = () => fs.writeFileSync(path.join(OUT, 'camera-manifest.json'), JSON.stringify(report, null, 2) + '\n');
await QRCode.toFile(source, `${BASE}/register#invite=${FIXTURE_CODE}`, { width: 512, margin: 4 });
const encode = spawnSync('rtk', ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-loop', '1', '-i', source,
  '-vf', 'scale=320:320,pad=640:480:(ow-iw)/2:(oh-ih)/2:white,format=yuv420p', '-r', '10', '-t', '2', '-f', 'yuv4mpegpipe', '-y', video], { encoding: 'utf8' });
assert.equal(encode.status, 0, encode.stderr || encode.stdout);

async function instrument(context) {
  await context.addInitScript(() => {
    window.__cameraQaTracks = [];
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      window.__cameraQaTracks.push(...stream.getTracks());
      return stream;
    };
  });
}
async function shot(page, file, description) {
  const viewport = page.viewportSize();
  const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
  record(layout.width <= layout.viewport + 1, `${file} 无整体横向溢出`);
  await page.screenshot({ path: path.join(OUT, file), fullPage: true });
  report.screenshots.push({ file, viewport: `${viewport.width}×${viewport.height}`, theme: 'light', description, path: '/register' });
  save();
}
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
report.browser = `Chrome ${browser.version()}`;
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  await instrument(context);
  const page = await context.newPage();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
  record(!/已去除 0\/O|二维码来源的邀请码在扫码后自动填入/.test(await page.locator('body').innerText()), '注册页已删除原邀请码说明');
  const exchangeResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/auth/invitations/exchange');
  await page.getByRole('button', { name: '扫描邀请码', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByLabel('邀请码', { exact: true }).waitFor();
  await page.waitForFunction(() => window.__cameraQaTracks.length > 0);
  record(true, '点击扫描按钮实际调用 getUserMedia 并取得视频轨道');
  await page.waitForFunction((code) => document.querySelector('#invite-code')?.value === code, FIXTURE_CODE, { timeout: 30_000 });
  record(true, '测试摄像头实际二维码被解码，同源邀请链接自动填入邀请码');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  record(await page.evaluate(() => window.__cameraQaTracks.every((track) => track.readyState === 'ended')), '识别成功立即停止相机全部轨道');
  record(!new URL(page.url()).hash, '扫码结果不写入地址栏 fragment');
  record((await exchangeResponse).status() === 400, '未签发的格式样例自动交给真实服务端验证并拒绝；未注册、未消费邀请名额');
  await shot(page, 'entry-register-camera-filled-light-390.png', '实际测试摄像头 QR 解码后填入未签发样例码；真实服务端拒绝，不注册');

  // 无相机授权的独立上下文，权限拒绝路径不伪造 getUserMedia。
  const deniedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await deniedContext.grantPermissions([], { origin: BASE });
  const deniedPage = await deniedContext.newPage();
  deniedPage.on('pageerror', (error) => report.errors.push(error.message));
  await deniedPage.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
  await deniedPage.getByRole('button', { name: '扫描邀请码', exact: true }).click();
  await deniedPage.getByText(/相机权限被拒绝/).first().waitFor();
  record(true, '真实浏览器相机权限拒绝时显示可操作提示');
  await shot(deniedPage, 'entry-register-camera-denied-light-390.png', '浏览器实际相机权限拒绝；保留关闭与手动输入');
  record(report.errors.length === 0, '相机解码与拒绝路径无未捕获页面异常');
  save();
  console.log(`相机检查完成：${report.checks.length} 项，${report.screenshots.length} 张截图。`);
} catch (error) {
  report.errors.push(error.message);
  save();
  throw error;
} finally {
  await browser.close();
  fs.rmSync(TEMP, { recursive: true, force: true });
}
