import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { randomUUID } from 'crypto';
import { writeBugToGBrain } from './gbrain.js';
import { triggerAutofix } from './autofix.js';

const app = new Hono();

app.use('*', cors());

app.post('/report', async (c) => {
  const body = await c.req.json();
  const id = randomUUID();

  console.log(`\n[report] received: "${body.title}" from ${body.url}`);

  writeBugToGBrain({ id, ...body });
  console.log(`[gbrain] written: ${id}.md`);

  triggerAutofix(id, body).catch((err) =>
    console.error('[autofix] failed:', err.message)
  );

  return c.json({ id, status: 'received' });
});

app.get('/health', (c) => c.json({ ok: true }));

serve({ fetch: app.fetch, port: 3001 }, () => {
  console.log('lite-annotate API running on http://localhost:3001');
});
