/**
 * TEST_PLAN section 7: two browser contexts, one per approver, against the full stack with
 * FakeProvider. Proposals come from the real agent code with a scripted model.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';
import type { Db, MongoClient } from 'mongodb';
import { connectWith } from '@escrowops/shared';
import { resolveTicket } from '@escrowops/agent';
import { proposeScript, scriptedModel } from '../agent/fake-model.js';
import { STATE_FILE, type E2EState } from './global-setup.js';

test.describe.configure({ mode: 'serial' });

let client: MongoClient;
let agentDb: Db;

test.beforeAll(async () => {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as E2EState;
  client = await connectWith(state.uri, 'escrow_agent', 'agent-dev-password', state.dbName);
  agentDb = client.db(state.dbName);
});
test.afterAll(async () => {
  await client?.close();
});

const propose = (ticket: string, order: string, cents: number) =>
  resolveTicket(ticket, { db: agentDb, model: 'claude-sonnet-5-5', createMessage: scriptedModel(proposeScript(ticket, order, cents)).createMessage });

async function approverPage(browser: Browser, approver: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/');
  await expect(page.getByTestId('feed-status')).toHaveText(/Live/);
  await page.getByTestId('login-approver').selectOption(approver);
  await page.getByTestId('login-password').fill(`${approver}-dev-password`);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('signed-in-as')).toContainText(approver);
  return page;
}

const card = (page: Page, column: string, ticket: string) => page.getByTestId(`column-${column}`).getByTestId(`ticket-${ticket}`);

test('U1: pipeline cards move through the stages without a reload', async ({ page }) => {
  await page.goto('/');
  await expect(card(page, 'intake', 'T-1001')).toBeVisible();
  await propose('T-1001', 'O-5101', 8900);
  await expect(card(page, 'paid', 'T-1001')).toBeVisible();
  await expect(card(page, 'paid', 'T-1001').getByTestId('refund-id')).toContainText('re_fake_');
});

test.describe('dual control on a $5,000 refund', () => {
  let a: Page;
  let b: Page;

  test.beforeAll(async ({ browser }) => {
    a = await approverPage(browser, 'approver-a');
    b = await approverPage(browser, 'approver-b');
  });

  test('U2: the held refund shows amount, tier, reason, evidence and the broken rule', async () => {
    await propose('T-1011', 'O-5111', 500_000);
    for (const page of [a, b]) {
      const held = card(page, 'held', 'T-1011');
      await expect(held).toBeVisible();
      await expect(held).toContainText('$5,000.00');
      await expect(held).toContainText('Dual control');
      await expect(held.getByTestId('reason')).not.toBeEmpty();
      await expect(held.getByTestId('evidence')).toContainText('order_line');
      await expect(held.getByTestId('rule')).toContainText('maximum');
      await expect(held.getByTestId('progress')).toHaveText('0 of 2');
    }
  });

  test('U3, U4: approver A approves; both browsers show 1 of 2 and A cannot approve again', async () => {
    await card(a, 'held', 'T-1011').getByTestId('approve').click();
    for (const page of [a, b]) await expect(card(page, 'held', 'T-1011').getByTestId('progress')).toHaveText('1 of 2');
    await expect(card(a, 'held', 'T-1011').getByTestId('approve')).toBeDisabled();
    await expect(card(b, 'held', 'T-1011').getByTestId('approve')).toBeEnabled();
  });

  test('U8: a reload mid-flow restores the state from the database', async () => {
    await b.reload();
    await expect(b.getByTestId('signed-in-as')).toContainText('approver-b');
    await expect(card(b, 'held', 'T-1011').getByTestId('progress')).toHaveText('1 of 2');
  });

  test('U5: approver B approves; both browsers show paid within 2 s', async () => {
    await card(b, 'held', 'T-1011').getByTestId('approve').click();
    for (const page of [a, b]) await expect(card(page, 'paid', 'T-1011')).toBeVisible({ timeout: 2000 });
  });

  test('U6: the audit timeline shows every stage in order, ending with the refund ID', async () => {
    await card(a, 'paid', 'T-1011').getByTestId('open-timeline').click();
    const events = a.getByTestId('timeline').getByTestId('timeline-event');
    await expect(events.last()).toContainText('re_fake_');
    const kinds = await events.evaluateAll((els) => els.map((e) => `${e.getAttribute('data-source')}:${e.getAttribute('data-kind')}`));
    const order = ['agent_traces:tool_call', 'review_queue:held', 'approvals:approve', 'approved:promoted', 'ledger:pending', 'ledger:succeeded'];
    let at = -1;
    for (const step of order) {
      const i = kinds.indexOf(step, at + 1);
      expect(i, `${step} in ${kinds.join(' > ')}`).toBeGreaterThan(at);
      at = i;
    }
    expect(kinds.filter((k) => k === 'approvals:approve')).toHaveLength(2);

    await a.getByRole('button', { name: 'Close' }).click();
    await expect(a.getByTestId('timeline')).toBeHidden();
  });

  test('U7: a rejection moves the card to stopped in both browsers', async () => {
    await propose('T-1009', 'O-5109', 129_900);
    await card(a, 'held', 'T-1009').getByTestId('reject').click();
    for (const page of [a, b]) {
      const stopped = card(page, 'stopped', 'T-1009');
      await expect(stopped).toBeVisible();
      await expect(stopped.getByTestId('stage')).toHaveText('Rejected');
    }
  });
});

test('U9: after the WebSocket drops and reconnects, the UI catches up with no missing cards', async ({ page }) => {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws\/pipeline$/, (ws) => {
    ws.connectToServer();
    sockets.push(ws);
  });
  await page.goto('/');
  await expect(page.getByTestId('feed-status')).toHaveText(/Live/);

  await sockets.at(-1)!.close();
  await expect(page.getByTestId('feed-status')).toHaveText(/Reconnecting|Live/);
  await propose('T-1003', 'O-5103', 2495); // happens around the drop

  await expect(page.getByTestId('feed-status')).toHaveText(/Live/);
  expect(sockets.length).toBeGreaterThanOrEqual(2);
  await expect(card(page, 'paid', 'T-1003')).toBeVisible();
  await expect(card(page, 'paid', 'T-1001')).toBeVisible();
});
