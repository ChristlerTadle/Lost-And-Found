const { randomUUID } = require('node:crypto');
const { access, unlink } = require('node:fs/promises');
const { MongoClient } = require('mongodb');
const path = require('node:path');
const config = require('../src/config');
const { createAuthService } = require('../src/services/auth');

async function main() {
  const client = new MongoClient(config.mongodbUri);
  let userId;
  let sessionCookie;
  let savedImagePath;
  await client.connect();
  const database = client.db(config.mongodbDatabase);
  const auth = createAuthService(database);
  const token = randomUUID();
  const email = `found-form-check-${token}@example.test`;
  const itemName = `Found form check ${token}`;

  try {
    const user = await auth.register({
      email,
      password: 'TemporaryCheck123!',
      full_name: 'Temporary Found Form Check',
      student_id: `CHECK-${token}`,
      department: 'College of Engineering',
      phone: '0000000000',
    });
    userId = user.id;

    const login = await fetch('http://127.0.0.1:3000/index.php?page=login', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'login', email, password: 'TemporaryCheck123!' }),
    });
    if (login.status !== 302) throw new Error(`Temporary sign-in returned HTTP ${login.status}.`);
    sessionCookie = login.headers.getSetCookie()[0].split(';')[0];

    const form = new FormData();
    for (const [key, value] of Object.entries({
      item_name: itemName,
      category: 'Other',
      location: 'Temporary test location',
      date_lost: new Date().toISOString().slice(0, 10),
      description: 'Temporary found-report form check.',
      identifying_details: 'Temporary private test details.',
    })) form.append(key, value);
    form.append('image', new Blob([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ], { type: 'image/png' }), 'found-item.png');

    const response = await fetch('http://127.0.0.1:3000/index.php?page=report&kind=found', {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: sessionCookie },
      body: form,
    });
    if (response.status !== 302 || !response.headers.get('location')?.includes('page=reports&found_submitted=1')) {
      throw new Error(`Found report submission returned HTTP ${response.status}.`);
    }
    const reportsPage = await fetch(`http://127.0.0.1:3000${response.headers.get('location')}`, {
      headers: { cookie: sessionCookie },
    });
    if (reportsPage.status !== 200 || !(await reportsPage.text()).includes('Next step: Bring the item to Lost and Found staff')) {
      throw new Error('Found-report follow-up instructions were not displayed.');
    }

    const saved = await database.collection('lost_items').findOne({ user_id: userId, item_name: itemName });
    if (saved?.image_path) savedImagePath = saved.image_path;
    if (!saved || saved.item_type !== 'found' || saved.status !== 'found'
      || !/^[0-9a-f-]+\.png$/i.test(saved.image_path || '')) {
      throw new Error('Found report fields and private image reference were not saved as expected.');
    }
    const privateImagePath = path.resolve(__dirname, '..', 'private_uploads', 'found', saved.image_path);
    await access(privateImagePath);

    const protectedImage = await fetch(`http://127.0.0.1:3000/index.php?page=staff-found-image&id=${saved._id}`, {
      headers: { cookie: sessionCookie },
    });
    if (protectedImage.status !== 403) throw new Error(`Found image access for a regular user returned HTTP ${protectedImage.status}.`);

    const publicImage = await fetch(`http://127.0.0.1:3000/private_uploads/found/${saved.image_path}`);
    if (publicImage.status !== 404) throw new Error(`Found image was publicly reachable with HTTP ${publicImage.status}.`);
    console.log('PASS: found-report image was stored privately and denied to regular users.');
  } finally {
    if (sessionCookie) {
      await fetch('http://127.0.0.1:3000/index.php?logout=1', { headers: { cookie: sessionCookie }, redirect: 'manual' }).catch(() => {});
    }
    if (userId) {
      await database.collection('item_claims').deleteMany({ user_id: userId });
      await database.collection('lost_items').deleteMany({ user_id: userId });
      await database.collection('users').deleteOne({ _id: userId });
    }
    if (savedImagePath) {
      await unlink(path.resolve(__dirname, '..', 'private_uploads', 'found', savedImagePath)).catch(() => {});
    }
    await client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
