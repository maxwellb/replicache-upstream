import {httpStatusUnauthorized} from './replicache';
import {
  addData,
  clock,
  expectLogContext,
  initReplicacheTesting,
  MemStoreWithCounters,
  replicacheForTesting,
  replicacheForTestingNoDefaultURLs,
  tickAFewTimes,
  tickUntil,
} from './test-util';
import {PatchOperation, Replicache, TransactionClosedError} from './mod';
import type {ReadTransaction, WriteTransaction} from './mod';
import type {JSONValue} from './json';
import {assert, expect} from '@esm-bundle/chai';
import * as sinon from 'sinon';
import type {ScanOptions} from './scan-options';
import {asyncIterableToArray} from './async-iterable-to-array';
import {sleep} from './sleep';
import * as db from './db/mod';
import {TestMemStore} from './kv/test-mem-store';
import {WriteTransactionImpl} from './transactions';
import {emptyHash, Hash} from './hash';
import {defaultPuller} from './puller';
import {defaultPusher} from './pusher';
import {
  PROD_LICENSE_SERVER_URL,
  TEST_LICENSE_KEY,
  LicenseStatus,
} from '@rocicorp/licensing/src/client';

// fetch-mock has invalid d.ts file so we removed that on npm install.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error
import fetchMock from 'fetch-mock/esm/client';
import type {Mutation} from './sync/push';
import type {ReplicacheOptions} from './replicache-options';
import {deleteClientForTesting} from './persist/clients-test-helpers.js';
import type {LogLevel} from '@rocicorp/logger';
import {
  LICENSE_ACTIVE_PATH,
  LICENSE_STATUS_PATH,
} from '@rocicorp/licensing/src/server/api-types';

const {fail} = assert;

initReplicacheTesting();

async function expectPromiseToReject(p: unknown): Promise<Chai.Assertion> {
  let e;
  try {
    await p;
  } catch (ex) {
    e = ex;
  }
  return expect(e);
}

async function expectAsyncFuncToThrow(f: () => unknown, c: unknown) {
  (await expectPromiseToReject(f())).to.be.instanceof(c);
}

test('name is required', () => {
  expect(
    () =>
      new Replicache({
        licenseKey: TEST_LICENSE_KEY,
      } as ReplicacheOptions<Record<string, never>>),
  ).to.throw(/name.*required/);
});

test('name cannot be empty', () => {
  expect(
    () => new Replicache({licenseKey: TEST_LICENSE_KEY, name: ''}),
  ).to.throw(/name.*must be non-empty/);
});

test('get, has, scan on empty db', async () => {
  const rep = await replicacheForTesting('test2');
  async function t(tx: ReadTransaction) {
    expect(await tx.get('key')).to.equal(undefined);
    expect(await tx.has('key')).to.be.false;

    const scanItems = await asyncIterableToArray(tx.scan());
    expect(scanItems).to.have.length(0);
  }

  await rep.query(t);
});

test('put, get, has, del inside tx', async () => {
  const rep = await replicacheForTesting('test3', {
    mutators: {
      testMut: async (
        tx: WriteTransaction,
        args: {key: string; value: JSONValue},
      ) => {
        const {key, value} = args;
        await tx.put(key, value);
        expect(await tx.has(key)).to.equal(true);
        const v = await tx.get(key);
        expect(v).to.deep.equal(value);

        expect(await tx.del(key)).to.equal(true);
        expect(await tx.has(key)).to.be.false;
      },
    },
  });

  const {testMut} = rep.mutate;

  for (const [key, value] of Object.entries({
    a: true,
    b: false,
    c: null,
    d: 'string',
    e: 12,
    f: {},
    g: [],
    h: {h1: true},
    i: [0, 1],
  })) {
    await testMut({key, value: value as JSONValue});
  }
});

async function testScanResult<K, V>(
  rep: Replicache,
  options: ScanOptions | undefined,
  entries: [K, V][],
) {
  await rep.query(async tx => {
    expect(
      await asyncIterableToArray(tx.scan(options).entries()),
    ).to.deep.equal(entries);
  });
  await rep.query(async tx => {
    expect(await asyncIterableToArray(tx.scan(options))).to.deep.equal(
      entries.map(([, v]) => v),
    );
  });
  await rep.query(async tx => {
    expect(await asyncIterableToArray(tx.scan(options).values())).to.deep.equal(
      entries.map(([, v]) => v),
    );
  });
  await rep.query(async tx => {
    expect(await asyncIterableToArray(tx.scan(options).keys())).to.deep.equal(
      entries.map(([k]) => k),
    );
  });

  await rep.query(async tx => {
    expect(await tx.scan(options).toArray()).to.deep.equal(
      entries.map(([, v]) => v),
    );
  });
  // scan().xxx().toArray()
  await rep.query(async tx => {
    expect(await tx.scan(options).entries().toArray()).to.deep.equal(entries);
  });
  await rep.query(async tx => {
    expect(await tx.scan(options).values().toArray()).to.deep.equal(
      entries.map(([, v]) => v),
    );
  });
  await rep.query(async tx => {
    expect(await tx.scan(options).keys().toArray()).to.deep.equal(
      entries.map(([k]) => k),
    );
  });
}

test('scan', async () => {
  const rep = await replicacheForTesting('test4', {
    mutators: {
      addData,
    },
  });
  const add = rep.mutate.addData;
  await add({
    'a/0': 0,
    'a/1': 1,
    'a/2': 2,
    'a/3': 3,
    'a/4': 4,
    'b/0': 5,
    'b/1': 6,
    'b/2': 7,
    'c/0': 8,
  });

  await testScanResult(rep, undefined, [
    ['a/0', 0],
    ['a/1', 1],
    ['a/2', 2],
    ['a/3', 3],
    ['a/4', 4],
    ['b/0', 5],
    ['b/1', 6],
    ['b/2', 7],
    ['c/0', 8],
  ]);

  await testScanResult(rep, {prefix: 'a'}, [
    ['a/0', 0],
    ['a/1', 1],
    ['a/2', 2],
    ['a/3', 3],
    ['a/4', 4],
  ]);

  await testScanResult(rep, {prefix: 'b'}, [
    ['b/0', 5],
    ['b/1', 6],
    ['b/2', 7],
  ]);

  await testScanResult(rep, {prefix: 'c/'}, [['c/0', 8]]);

  await testScanResult(
    rep,
    {
      start: {key: 'b/1', exclusive: false},
    },
    [
      ['b/1', 6],
      ['b/2', 7],
      ['c/0', 8],
    ],
  );

  await testScanResult(
    rep,
    {
      start: {key: 'b/1'},
    },
    [
      ['b/1', 6],
      ['b/2', 7],
      ['c/0', 8],
    ],
  );

  await testScanResult(
    rep,
    {
      start: {key: 'b/1', exclusive: true},
    },
    [
      ['b/2', 7],
      ['c/0', 8],
    ],
  );

  await testScanResult(
    rep,
    {
      limit: 3,
    },
    [
      ['a/0', 0],
      ['a/1', 1],
      ['a/2', 2],
    ],
  );

  await testScanResult(
    rep,
    {
      limit: 10,
      prefix: 'a/',
    },
    [
      ['a/0', 0],
      ['a/1', 1],
      ['a/2', 2],
      ['a/3', 3],
      ['a/4', 4],
    ],
  );

  await testScanResult(
    rep,
    {
      limit: 1,
      prefix: 'b/',
    },
    [['b/0', 5]],
  );
});

test('name', async () => {
  const repA = await replicacheForTesting('a', {mutators: {addData}});
  const repB = await replicacheForTesting('b', {mutators: {addData}});

  const addA = repA.mutate.addData;
  const addB = repB.mutate.addData;

  await addA({key: 'A'});
  await addB({key: 'B'});

  expect(await repA.query(tx => tx.get('key'))).to.equal('A');
  expect(await repB.query(tx => tx.get('key'))).to.equal('B');

  await repA.close();
  await repB.close();

  indexedDB.deleteDatabase(repA.idbName);
  indexedDB.deleteDatabase(repB.idbName);
});

test('register with error', async () => {
  const rep = await replicacheForTesting('regerr', {
    mutators: {
      err: async (_: WriteTransaction, args: number) => {
        throw args;
      },
    },
  });

  const doErr = rep.mutate.err;

  try {
    await doErr(42);
    fail('Should have thrown');
  } catch (ex) {
    expect(ex).to.equal(42);
  }
});

test('overlapping writes', async () => {
  async function dbWait(tx: ReadTransaction, dur: number) {
    // Try to take setTimeout away from me???
    const t0 = Date.now();
    while (Date.now() - t0 > dur) {
      await tx.get('foo');
    }
  }

  const pushURL = 'https://push.com';
  // writes wait on writes
  const rep = await replicacheForTesting('conflict', {
    pushURL,
    mutators: {
      'wait-then-return': async <T extends JSONValue>(
        tx: ReadTransaction,
        {duration, ret}: {duration: number; ret: T},
      ) => {
        await dbWait(tx, duration);
        return ret;
      },
    },
  });
  fetchMock.post(pushURL, {});

  const mut = rep.mutate['wait-then-return'];

  let resA = mut({duration: 250, ret: 'a'});
  // create a gap to make sure resA starts first (our rwlock isn't fair).
  await clock.tickAsync(100);
  let resB = mut({duration: 0, ret: 'b'});
  // race them, a should complete first, indicating that b waited
  expect(await Promise.race([resA, resB])).to.equal('a');
  // wait for the other to finish so that we're starting from null state for next one.
  await Promise.all([resA, resB]);

  // reads wait on writes
  resA = mut({duration: 250, ret: 'a'});
  await clock.tickAsync(100);
  resB = rep.query(() => 'b');
  await tickAFewTimes();
  expect(await Promise.race([resA, resB])).to.equal('a');

  await tickAFewTimes();
  await resA;
  await tickAFewTimes();
  await resB;
});

test('push', async () => {
  const pushURL = 'https://push.com';

  const rep = await replicacheForTesting('push', {
    auth: '1',
    pushURL,
    pushDelay: 10,
    mutators: {
      createTodo: async <A extends {id: number}>(
        tx: WriteTransaction,
        args: A,
      ) => {
        createCount++;
        await tx.put(`/todo/${args.id}`, args);
      },
      deleteTodo: async <A extends {id: number}>(
        tx: WriteTransaction,
        args: A,
      ) => {
        deleteCount++;
        await tx.del(`/todo/${args.id}`);
      },
    },
  });

  let createCount = 0;
  let deleteCount = 0;

  const {createTodo, deleteTodo} = rep.mutate;

  const id1 = 14323534;
  const id2 = 22354345;

  await deleteTodo({id: id1});
  await deleteTodo({id: id2});

  expect(deleteCount).to.equal(2);

  fetchMock.postOnce(pushURL, {
    mutationInfos: [
      {id: 1, error: 'deleteTodo: todo not found'},
      {id: 2, error: 'deleteTodo: todo not found'},
    ],
  });
  await tickAFewTimes();
  expect(deleteCount).to.equal(2);
  const {mutations} = await fetchMock.lastCall().request.json();
  expect(mutations).to.deep.equal([
    {id: 1, name: 'deleteTodo', args: {id: id1}, timestamp: 100},
    {id: 2, name: 'deleteTodo', args: {id: id2}, timestamp: 100},
  ]);

  await createTodo({
    id: id1,
    text: 'Test',
  });
  expect(createCount).to.equal(1);
  expect(
    ((await rep?.query(tx => tx.get(`/todo/${id1}`))) as {text: string}).text,
  ).to.equal('Test');

  fetchMock.postOnce(pushURL, {
    mutationInfos: [{id: 3, error: 'mutation has already been processed'}],
  });
  await tickAFewTimes();
  {
    const {mutations} = await fetchMock.lastCall().request.json();
    expect(mutations).to.deep.equal([
      {id: 1, name: 'deleteTodo', args: {id: id1}, timestamp: 100},
      {id: 2, name: 'deleteTodo', args: {id: id2}, timestamp: 100},
      {
        id: 3,
        name: 'createTodo',
        args: {id: id1, text: 'Test'},
        timestamp: 200,
      },
    ]);
  }

  await createTodo({
    id: id2,
    text: 'Test 2',
  });
  expect(createCount).to.equal(2);
  expect(
    ((await rep?.query(tx => tx.get(`/todo/${id2}`))) as {text: string}).text,
  ).to.equal('Test 2');

  // Clean up
  await deleteTodo({id: id1});
  await deleteTodo({id: id2});

  expect(deleteCount).to.equal(4);
  expect(createCount).to.equal(2);

  fetchMock.postOnce(pushURL, {
    mutationInfos: [],
  });
  await tickAFewTimes();
  {
    const {mutations} = await fetchMock.lastCall().request.json();
    expect(mutations).to.deep.equal([
      {id: 1, name: 'deleteTodo', args: {id: id1}, timestamp: 100},
      {id: 2, name: 'deleteTodo', args: {id: id2}, timestamp: 100},
      {
        id: 3,
        name: 'createTodo',
        args: {id: id1, text: 'Test'},
        timestamp: 200,
      },
      {
        id: 4,
        name: 'createTodo',
        args: {id: id2, text: 'Test 2'},
        timestamp: 300,
      },
      {id: 5, name: 'deleteTodo', args: {id: id1}, timestamp: 300},
      {id: 6, name: 'deleteTodo', args: {id: id2}, timestamp: 300},
    ]);
  }

  expect(deleteCount).to.equal(4);
  expect(createCount).to.equal(2);
});

test('push delay', async () => {
  const pushURL = 'https://push.com';

  const rep = await replicacheForTesting('push', {
    auth: '1',
    pushURL,
    pushDelay: 1,
    mutators: {
      createTodo: async <A extends {id: number}>(
        tx: WriteTransaction,
        args: A,
      ) => {
        await tx.put(`/todo/${args.id}`, args);
      },
    },
  });

  const {createTodo} = rep.mutate;

  const id1 = 14323534;

  await tickAFewTimes();
  fetchMock.reset();

  fetchMock.postOnce(pushURL, {
    mutationInfos: [],
  });

  expect(fetchMock.calls()).to.have.length(0);

  await createTodo({id: id1});

  expect(fetchMock.calls()).to.have.length(0);

  await tickAFewTimes();

  expect(fetchMock.calls()).to.have.length(1);
});

test('push request is only sent when pushURL or non-default pusher are set', async () => {
  const rep = await replicacheForTestingNoDefaultURLs('no push requests', {
    auth: '1',
    pullURL: 'https://diff.com/pull',
    pushDelay: 1,
    mutators: {
      createTodo: async <A extends {id: number}>(
        tx: WriteTransaction,
        args: A,
      ) => {
        await tx.put(`/todo/${args.id}`, args);
      },
    },
  });

  const {createTodo} = rep.mutate;

  await tickAFewTimes();
  fetchMock.reset();
  fetchMock.postAny({});

  await createTodo({id: 'id1'});
  await tickAFewTimes();

  expect(fetchMock.calls()).to.have.length(0);

  await tickAFewTimes();
  fetchMock.reset();
  fetchMock.postAny({});

  rep.pushURL = 'https://diff.com/push';

  await createTodo({id: 'id2'});
  await tickAFewTimes();
  expect(fetchMock.calls()).to.have.length(1);

  await tickAFewTimes();
  fetchMock.reset();
  fetchMock.postAny({});

  rep.pushURL = '';

  await createTodo({id: 'id3'});
  await tickAFewTimes();
  expect(fetchMock.calls()).to.have.length(0);

  await tickAFewTimes();
  fetchMock.reset();
  fetchMock.postAny({});
  let pusherCallCount = 0;

  rep.pusher = () => {
    pusherCallCount++;
    return Promise.resolve({
      httpStatusCode: 200,
      errorMessage: '',
    });
  };

  await createTodo({id: 'id4'});
  await tickAFewTimes();

  expect(fetchMock.calls()).to.have.length(0);
  expect(pusherCallCount).to.equal(1);

  await tickAFewTimes();
  fetchMock.reset();
  fetchMock.postAny({});
  pusherCallCount = 0;

  rep.pusher = defaultPusher;

  await createTodo({id: 'id5'});
  await tickAFewTimes();

  expect(fetchMock.calls()).to.have.length(0);
  expect(pusherCallCount).to.equal(0);
});

test('pull', async () => {
  const pullURL = 'https://diff.com/pull';

  const rep = await replicacheForTesting('pull', {
    auth: '1',
    pullURL,
    mutators: {
      createTodo: async <A extends {id: number}>(
        tx: WriteTransaction,
        args: A,
      ) => {
        createCount++;
        await tx.put(`/todo/${args.id}`, args);
      },
      deleteTodo: async <A extends {id: number}>(
        tx: WriteTransaction,
        args: A,
      ) => {
        deleteCount++;
        await tx.del(`/todo/${args.id}`);
      },
    },
  });

  let createCount = 0;
  let deleteCount = 0;
  let syncHead: Hash;
  let beginPullResult: {
    requestID: string;
    syncHead: Hash;
    ok: boolean;
  };

  const {createTodo, deleteTodo} = rep.mutate;

  const id1 = 14323534;
  const id2 = 22354345;

  await deleteTodo({id: id1});
  await deleteTodo({id: id2});

  expect(deleteCount).to.equal(2);

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 2,
    patch: [
      {op: 'del', key: ''},
      {
        op: 'put',
        key: '/list/1',
        value: {id: 1, ownerUserID: 1},
      },
    ],
  });
  rep.pull();
  await tickAFewTimes();
  expect(deleteCount).to.equal(2);

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 2,
    patch: [],
  });
  beginPullResult = await rep.beginPull();
  ({syncHead} = beginPullResult);
  expect(syncHead).to.equal(emptyHash);
  expect(deleteCount).to.equal(2);

  await createTodo({
    id: id1,
    text: 'Test',
  });
  expect(createCount).to.equal(1);
  expect(
    ((await rep?.query(tx => tx.get(`/todo/${id1}`))) as {text: string}).text,
  ).to.equal('Test');

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 3,
    patch: [
      {
        op: 'put',
        key: '/todo/14323534',
        value: {id: 14323534, text: 'Test'},
      },
    ],
  });
  beginPullResult = await rep.beginPull();
  ({syncHead} = beginPullResult);
  expect(syncHead).equal('t/000000000000000000000000000007');

  await createTodo({
    id: id2,
    text: 'Test 2',
  });
  expect(createCount).to.equal(2);
  expect(
    ((await rep?.query(tx => tx.get(`/todo/${id2}`))) as {text: string}).text,
  ).to.equal('Test 2');

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 3,
    patch: [],
  });
  await rep.maybeEndPull(beginPullResult);

  expect(createCount).to.equal(3);

  // Clean up
  await deleteTodo({id: id1});
  await deleteTodo({id: id2});

  expect(deleteCount).to.equal(4);
  expect(createCount).to.equal(3);

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 6,
    patch: [{op: 'del', key: '/todo/14323534'}],
  });
  rep.pull();
  await tickAFewTimes();

  expect(deleteCount).to.equal(4);
  expect(createCount).to.equal(3);
});

function expectConsoleLogContextStub(
  name: string,
  call: sinon.SinonSpyCall,
  expectedMessage: string,
) {
  const {args} = call;
  expect(args).to.have.length(2);
  expect(args[0]).to.equal(`name=${name}`);
  expect(args[1]).to.equal(expectedMessage);
}

test('reauth pull', async () => {
  const pullURL = 'https://diff.com/pull';

  const rep = await replicacheForTesting('reauth', {
    pullURL,
    auth: 'wrong',
  });

  fetchMock.post(pullURL, {body: 'xxx', status: httpStatusUnauthorized});

  const consoleErrorStub = sinon.stub(console, 'error');

  const getAuthFake = sinon.fake.returns(null);
  rep.getAuth = getAuthFake;

  await rep.beginPull();

  expect(getAuthFake.callCount).to.equal(1);
  expect(consoleErrorStub.callCount).to.equal(1);
  expectConsoleLogContextStub(
    rep.name,
    consoleErrorStub.lastCall,
    'Got error response from server (https://diff.com/pull) doing pull: 401: xxx',
  );

  {
    const consoleInfoStub = sinon.stub(console, 'info');
    const getAuthFake = sinon.fake(() => 'boo');
    rep.getAuth = getAuthFake;

    expect((await rep.beginPull()).syncHead).to.equal(emptyHash);

    expect(getAuthFake.callCount).to.equal(8);
    expect(consoleErrorStub.callCount).to.equal(9);
    expectConsoleLogContextStub(
      rep.name,
      consoleInfoStub.lastCall,
      'Tried to reauthenticate too many times',
    );
  }
});

test('pull request is only sent when pullURL or non-default puller are set', async () => {
  const rep = await replicacheForTestingNoDefaultURLs('no push requests', {
    auth: '1',
    pushURL: 'https://diff.com/push',
  });

  await tickAFewTimes();
  fetchMock.reset();
  fetchMock.postAny({});

  rep.pull();
  await tickAFewTimes();

  expect(fetchMock.calls()).to.have.length(0);

  await tickAFewTimes();
  fetchMock.reset();

  rep.pullURL = 'https://diff.com/pull';
  fetchMock.post(rep.pullURL, {lastMutationID: 0, patch: []});

  rep.pull();
  await tickAFewTimes();
  expect(fetchMock.calls()).to.have.length.greaterThan(0);

  await tickAFewTimes();
  fetchMock.reset();
  fetchMock.postAny({});

  rep.pullURL = '';

  rep.pull();
  await tickAFewTimes();
  expect(fetchMock.calls()).to.have.length(0);

  await tickAFewTimes();
  fetchMock.reset();
  fetchMock.postAny({});

  let pullerCallCount = 0;

  const consoleErrorStub = sinon.stub(console, 'error');

  rep.puller = () => {
    pullerCallCount++;
    return Promise.resolve({
      httpRequestInfo: {
        httpStatusCode: 500,
        errorMessage: 'Test failure',
      },
    });
  };

  rep.pull();
  await tickAFewTimes();

  expect(fetchMock.calls()).to.have.length(0);
  expect(pullerCallCount).to.be.greaterThan(0);

  expectConsoleLogContextStub(
    rep.name,
    consoleErrorStub.firstCall,
    'Got error response from server () doing pull: 500: Test failure',
  );
  consoleErrorStub.restore();

  await tickAFewTimes();
  fetchMock.reset();
  fetchMock.postAny({});
  pullerCallCount = 0;

  rep.puller = defaultPuller;

  rep.pull();
  await tickAFewTimes();

  expect(fetchMock.calls()).to.have.length(0);
  expect(pullerCallCount).to.equal(0);
});

test('reauth push', async () => {
  const pushURL = 'https://diff.com/push';

  const rep = await replicacheForTesting('reauth', {
    pushURL,
    pushDelay: 0,
    mutators: {
      noop() {
        // no op
      },
    },
  });

  const consoleErrorStub = sinon.stub(console, 'error');
  const getAuthFake = sinon.fake.returns(null);
  rep.getAuth = getAuthFake;

  await tickAFewTimes();

  fetchMock.post(pushURL, {body: 'xxx', status: httpStatusUnauthorized});

  await rep.mutate.noop();
  await tickUntil(() => getAuthFake.callCount > 0, 1);

  expectConsoleLogContextStub(
    rep.name,
    consoleErrorStub.firstCall,
    'Got error response from server (https://diff.com/push) doing push: 401: xxx',
  );

  {
    await tickAFewTimes();

    const consoleInfoStub = sinon.stub(console, 'info');
    const getAuthFake = sinon.fake(() => 'boo');
    rep.getAuth = getAuthFake;

    await rep.mutate.noop();
    await tickUntil(() => consoleInfoStub.callCount > 0, 1);

    expectConsoleLogContextStub(
      rep.name,
      consoleInfoStub.firstCall,
      'Tried to reauthenticate too many times',
    );
  }
});

test('HTTP status pull', async () => {
  const pullURL = 'https://diff.com/pull';

  const rep = await replicacheForTesting('http-status-pull', {
    pullURL,
  });

  let okCalled = false;
  let i = 0;
  fetchMock.post(pullURL, () => {
    switch (i++) {
      case 0:
        return {body: 'internal error', status: 500};
      case 1:
        return {body: 'not found', status: 404};
      default:
        okCalled = true;
        return {body: {lastMutationID: 0, patch: []}, status: 200};
    }
  });

  const consoleErrorStub = sinon.stub(console, 'error');

  rep.pull();

  await tickAFewTimes(20, 10);

  expect(consoleErrorStub.callCount).to.equal(2);
  expectConsoleLogContextStub(
    rep.name,
    consoleErrorStub.firstCall,
    'Got error response from server (https://diff.com/pull) doing pull: 500: internal error',
  );
  expectConsoleLogContextStub(
    rep.name,
    consoleErrorStub.lastCall,
    'Got error response from server (https://diff.com/pull) doing pull: 404: not found',
  );

  expect(okCalled).to.equal(true);
});

test('HTTP status push', async () => {
  const pushURL = 'https://diff.com/push';

  const rep = await replicacheForTesting('http-status-push', {
    pushURL,
    pushDelay: 1,
    mutators: {addData},
  });
  const add = rep.mutate.addData;

  let okCalled = false;
  let i = 0;
  fetchMock.post(pushURL, () => {
    switch (i++) {
      case 0:
        return {body: 'internal error', status: 500};
      case 1:
        return {body: 'not found', status: 404};
      default:
        okCalled = true;
        return {body: {}, status: 200};
    }
  });

  const consoleErrorStub = sinon.stub(console, 'error');

  await add({
    a: 0,
  });

  await tickAFewTimes(20, 10);

  expect(consoleErrorStub.callCount).to.equal(2);
  expectConsoleLogContextStub(
    rep.name,
    consoleErrorStub.firstCall,
    'Got error response from server (https://diff.com/push) doing push: 500: internal error',
  );
  expectConsoleLogContextStub(
    rep.name,
    consoleErrorStub.lastCall,
    'Got error response from server (https://diff.com/push) doing push: 404: not found',
  );

  expect(okCalled).to.equal(true);
});

test('poke', async () => {
  // TODO(MP) test:
  // - when we queue a poke and it matches, we update the snapshot
  // - rebase still works
  // - when the cookie doesn't match, it doesn't apply, but later when the cookie matches it does
  // - per-client timing
  const rep = await replicacheForTesting('poke', {
    auth: '1',
    mutators: {
      setTodo: async <A extends {id: number}>(
        tx: WriteTransaction,
        args: A,
      ) => {
        await tx.put(`/todo/${args.id}`, args);
      },
    },
  });

  const {setTodo} = rep.mutate;

  const id = 1;
  const key = `/todo/${id}`;
  const text = 'yo';

  await setTodo({id, text});
  expect(await rep.query(tx => tx.has(key))).true;

  // cookie *does* apply
  await rep.poke({
    baseCookie: null,
    pullResponse: {
      cookie: 'c1',
      lastMutationID: 1,
      patch: [{op: 'del', key}],
    },
  });
  expect(await rep.query(tx => tx.has(key))).false;

  // cookie does not apply
  await setTodo({id, text});
  let error = null;
  try {
    await rep.poke({
      baseCookie: null,
      pullResponse: {
        cookie: 'c1',
        lastMutationID: 1,
        patch: [{op: 'del', key}],
      },
    });
  } catch (e) {
    error = String(e);
  }
  expect(error).contains('unexpected base cookie for poke');
  expect(await rep.query(tx => tx.has(key))).true;

  // cookie applies, but lmid goes backward - should be an error.
  await setTodo({id, text});
  error = null;
  try {
    // blech could not figure out how to use chai-as-promised.
    await rep.poke({
      baseCookie: 'c1',
      pullResponse: {
        cookie: 'c2',
        lastMutationID: 0,
        patch: [{op: 'del', key}],
      },
    });
  } catch (e: unknown) {
    error = String(e);
  }
  expect(error).contains(
    'Received lastMutationID 0 is < than last snapshot lastMutationID 1; ignoring client view',
  );
});

test('closed tx', async () => {
  const rep = await replicacheForTesting('reauth', {
    mutators: {
      mut: async tx => {
        wtx = tx;
      },
    },
  });

  let rtx: ReadTransaction;
  await rep.query(tx => (rtx = tx));

  await expectAsyncFuncToThrow(() => rtx.get('x'), TransactionClosedError);
  await expectAsyncFuncToThrow(() => rtx.has('y'), TransactionClosedError);
  await expectAsyncFuncToThrow(
    () => rtx.scan().values().next(),
    TransactionClosedError,
  );

  let wtx: WriteTransaction | undefined;

  await rep.mutate.mut();
  expect(wtx).to.not.be.undefined;
  await expectAsyncFuncToThrow(() => wtx?.put('z', 1), TransactionClosedError);
  await expectAsyncFuncToThrow(() => wtx?.del('w'), TransactionClosedError);
});

test('pullInterval in constructor', async () => {
  const rep = await replicacheForTesting('pullInterval', {
    pullInterval: 12.34,
  });
  expect(rep.pullInterval).to.equal(12.34);
  await rep.close();
});

test('index', async () => {
  const rep = await replicacheForTesting('test-index', {mutators: {addData}});

  const add = rep.mutate.addData;
  await add({
    'a/0': {a: '0'},
    'a/1': {a: '1'},
    'a/2': {a: '2'},
    'a/3': {a: '3'},
    'a/4': {a: '4'},
    'b/0': {bc: '5'},
    'b/1': {bc: '6'},
    'b/2': {bc: '7'},
    'c/0': {bc: '8'},
    'd/0': {d: {e: {f: '9'}}},
  });
  await rep.createIndex({name: 'aIndex', jsonPointer: '/a'});

  await testScanResult(rep, {indexName: 'aIndex'}, [
    [['0', 'a/0'], {a: '0'}],
    [['1', 'a/1'], {a: '1'}],
    [['2', 'a/2'], {a: '2'}],
    [['3', 'a/3'], {a: '3'}],
    [['4', 'a/4'], {a: '4'}],
  ]);
  await rep.dropIndex('aIndex');
  await rep.query(async tx => {
    const x = tx.scan({indexName: 'aIndex'});
    (await expectPromiseToReject(x.values().next())).to.be
      .instanceOf(Error)
      .with.property('message', 'Unknown index name: aIndex');
    return x;
  });

  await rep.createIndex({name: 'aIndex', jsonPointer: '/a'});
  await testScanResult(rep, {indexName: 'aIndex'}, [
    [['0', 'a/0'], {a: '0'}],
    [['1', 'a/1'], {a: '1'}],
    [['2', 'a/2'], {a: '2'}],
    [['3', 'a/3'], {a: '3'}],
    [['4', 'a/4'], {a: '4'}],
  ]);
  await rep.dropIndex('aIndex');
  (
    await expectPromiseToReject(
      rep.query(tx => tx.scan({indexName: 'aIndex'}).toArray()),
    )
  ).to.be
    .instanceOf(Error)
    .with.property('message', 'Unknown index name: aIndex');

  await rep.createIndex({name: 'bc', prefix: 'c/', jsonPointer: '/bc'});
  await testScanResult(rep, {indexName: 'bc'}, [[['8', 'c/0'], {bc: '8'}]]);
  await add({
    'c/1': {bc: '88'},
  });
  await testScanResult(rep, {indexName: 'bc'}, [
    [['8', 'c/0'], {bc: '8'}],
    [['88', 'c/1'], {bc: '88'}],
  ]);
  await rep.dropIndex('bc');

  await rep.createIndex({name: 'dIndex', jsonPointer: '/d/e/f'});
  await testScanResult(rep, {indexName: 'dIndex'}, [
    [['9', 'd/0'], {d: {e: {f: '9'}}}],
  ]);
  await rep.dropIndex('dIndex');

  await add({
    'e/0': {'': ''},
  });
  await rep.createIndex({name: 'emptyKeyIndex', jsonPointer: '/'});
  await testScanResult(rep, {indexName: 'emptyKeyIndex'}, [
    [['', 'e/0'], {'': ''}],
  ]);
  await rep.dropIndex('emptyKeyIndex');
});

test('index array', async () => {
  const rep = await replicacheForTesting('test-index', {mutators: {addData}});

  const add = rep.mutate.addData;
  await add({
    'a/0': {a: []},
    'a/1': {a: ['0']},
    'a/2': {a: ['1', '2']},
    'a/3': {a: '3'},
    'a/4': {a: ['4']},
    'b/0': {bc: '5'},
    'b/1': {bc: '6'},
    'b/2': {bc: '7'},
    'c/0': {bc: '8'},
  });

  await rep.createIndex({name: 'aIndex', jsonPointer: '/a'});
  await testScanResult(rep, {indexName: 'aIndex'}, [
    [['0', 'a/1'], {a: ['0']}],
    [['1', 'a/2'], {a: ['1', '2']}],
    [['2', 'a/2'], {a: ['1', '2']}],
    [['3', 'a/3'], {a: '3'}],
    [['4', 'a/4'], {a: ['4']}],
  ]);
  await rep.dropIndex('aIndex');
});

test('index scan start', async () => {
  const rep = await replicacheForTesting('test-index-scan', {
    mutators: {addData},
  });

  const add = rep.mutate.addData;
  await add({
    'a/1': {a: '0'},
    'b/0': {b: 'a5'},
    'b/1': {b: 'a6'},
    'b/2': {b: 'b7'},
    'b/3': {b: 'b8'},
  });

  await rep.createIndex({
    name: 'bIndex',
    jsonPointer: '/b',
  });

  for (const key of ['a6', ['a6'], ['a6', undefined], ['a6', '']] as (
    | string
    | [string, string?]
  )[]) {
    await testScanResult(rep, {indexName: 'bIndex', start: {key}}, [
      [['a6', 'b/1'], {b: 'a6'}],
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ]);
    await testScanResult(
      rep,
      {indexName: 'bIndex', start: {key, exclusive: false}},
      [
        [['a6', 'b/1'], {b: 'a6'}],
        [['b7', 'b/2'], {b: 'b7'}],
        [['b8', 'b/3'], {b: 'b8'}],
      ],
    );
  }

  for (const key of ['a6', ['a6'], ['a6', undefined]] as (
    | string
    | [string, string?]
  )[]) {
    await testScanResult(
      rep,
      {indexName: 'bIndex', start: {key, exclusive: false}},
      [
        [['a6', 'b/1'], {b: 'a6'}],
        [['b7', 'b/2'], {b: 'b7'}],
        [['b8', 'b/3'], {b: 'b8'}],
      ],
    );
    await testScanResult(
      rep,
      {indexName: 'bIndex', start: {key: ['a6', ''], exclusive: true}},
      [
        [['a6', 'b/1'], {b: 'a6'}],
        [['b7', 'b/2'], {b: 'b7'}],
        [['b8', 'b/3'], {b: 'b8'}],
      ],
    );
  }

  for (const key of ['a6', ['a6'], ['a6', undefined]] as (
    | string
    | [string, string?]
  )[]) {
    await testScanResult(
      rep,
      {indexName: 'bIndex', start: {key, exclusive: true}},
      [
        [['b7', 'b/2'], {b: 'b7'}],
        [['b8', 'b/3'], {b: 'b8'}],
      ],
    );
  }

  await testScanResult(
    rep,
    {indexName: 'bIndex', start: {key: ['b7', 'b/2']}},
    [
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ],
  );
  await testScanResult(
    rep,
    {indexName: 'bIndex', start: {key: ['b7', 'b/2'], exclusive: false}},
    [
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ],
  );
  await testScanResult(
    rep,
    {indexName: 'bIndex', start: {key: ['b7', 'b/2'], exclusive: true}},
    [[['b8', 'b/3'], {b: 'b8'}]],
  );

  await testScanResult(
    rep,
    {indexName: 'bIndex', start: {key: ['a6', 'b/2']}},
    [
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ],
  );
  await testScanResult(
    rep,
    {indexName: 'bIndex', start: {key: ['a6', 'b/2'], exclusive: false}},
    [
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ],
  );
  await testScanResult(
    rep,
    {indexName: 'bIndex', start: {key: ['a6', 'b/2'], exclusive: true}},
    [
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ],
  );

  await rep.dropIndex('bIndex');
});

test('logLevel', async () => {
  const info = sinon.stub(console, 'info');
  const debug = sinon.stub(console, 'debug');

  // Just testing that we get some output
  let rep = await replicacheForTesting('log-level', {logLevel: 'error'});
  await rep.query(() => 42);
  expect(info.callCount).to.equal(0);
  await rep.close();

  info.reset();
  debug.reset();
  await tickAFewTimes(10, 100);

  rep = await replicacheForTesting('log-level', {logLevel: 'info'});
  await rep.query(() => 42);
  expect(info.callCount).to.equal(2 /* licensing log lines */);
  expect(debug.callCount).to.equal(0);
  await rep.close();

  info.reset();
  debug.reset();
  await tickAFewTimes(10, 100);

  rep = await replicacheForTesting('log-level', {logLevel: 'debug'});

  await rep.query(() => 42);
  expect(info.callCount).to.equal(2 /* licensing log lines */);
  expect(debug.callCount).to.be.greaterThan(0);

  expect(
    debug.getCalls().some(call => call.firstArg.startsWith(`name=${rep.name}`)),
  ).to.equal(true);
  expect(
    debug
      .getCalls()
      .some(call => call.args.length > 0 && call.args[1].endsWith('PULL')),
  ).to.equal(true);
  expect(
    debug
      .getCalls()
      .some(call => call.args.length > 0 && call.args[1].endsWith('PUSH')),
  ).to.equal(true);

  await rep.close();
});

test('logSinks length 0', async () => {
  const infoStub = sinon.stub(console, 'info');
  const debugStub = sinon.stub(console, 'debug');
  const expectNoLogsToConsole = () => {
    expect(infoStub.callCount).to.equal(0);
    expect(debugStub.callCount).to.equal(0);
  };

  const resetLogCounts = () => {
    infoStub.reset();
    debugStub.reset();
  };

  resetLogCounts();
  let rep = await replicacheForTesting('logSinks-0', {
    logLevel: 'info',
    logSinks: [],
  });
  await rep.query(() => 42);
  expectNoLogsToConsole();
  await rep.close();
  rep = await replicacheForTesting('logSinks-0', {
    logLevel: 'debug',
    logSinks: [],
  });
  await rep.query(() => 42);
  expectNoLogsToConsole();
  await rep.close();
});

test('logSinks length 1', async () => {
  const infoStub = sinon.stub(console, 'info');
  const debugStub = sinon.stub(console, 'debug');
  const expectNoLogsToConsole = () => {
    expect(infoStub.callCount).to.equal(0);
    expect(debugStub.callCount).to.equal(0);
  };

  const initLogCounts = () => ({
    info: 0,
    debug: 0,
    error: 0,
  });
  let logCounts: Record<LogLevel, number> = initLogCounts();
  const resetLogCounts = () => {
    logCounts = initLogCounts();
    infoStub.reset();
    debugStub.reset();
  };

  const logSink = {
    log: (level: LogLevel, ..._args: unknown[]) => {
      logCounts[level]++;
    },
  };
  resetLogCounts();
  let rep = await replicacheForTesting('logSinks-1', {
    logLevel: 'info',
    logSinks: [logSink],
  });
  await rep.query(() => 42);
  expect(logCounts.info).to.be.greaterThan(0);
  expect(logCounts.debug).to.equal(0);
  expectNoLogsToConsole();
  await rep.close();

  logCounts = initLogCounts();
  rep = await replicacheForTesting('logSinks-1', {
    logLevel: 'debug',
    logSinks: [logSink],
  });
  await rep.query(() => 42);
  expect(logCounts.info).to.be.greaterThan(0);
  expect(logCounts.debug).to.be.greaterThan(0);
  expectNoLogsToConsole();
  await rep.close();
});

test('logSinks length 3', async () => {
  const infoStub = sinon.stub(console, 'info');
  const debugStub = sinon.stub(console, 'debug');
  const expectNoLogsToConsole = () => {
    expect(infoStub.callCount).to.equal(0);
    expect(debugStub.callCount).to.equal(0);
  };

  const initLogCounts = () =>
    Array.from({length: 3}, () => ({
      info: 0,
      debug: 0,
      error: 0,
    }));
  let logCounts: Record<LogLevel, number>[] = initLogCounts();
  const resetLogCounts = () => {
    logCounts = initLogCounts();
    infoStub.reset();
    debugStub.reset();
  };

  const logSinks = Array.from({length: 3}, (_, i) => ({
    log: (level: LogLevel, ..._args: unknown[]) => {
      logCounts[i][level]++;
    },
  }));
  resetLogCounts();
  let rep = await replicacheForTesting('log-level', {
    logLevel: 'info',
    logSinks,
  });
  await rep.query(() => 42);
  for (const counts of logCounts) {
    expect(counts.info).to.be.greaterThan(0);
    expect(counts.debug).to.equal(0);
  }
  expectNoLogsToConsole();
  await rep.close();

  logCounts = initLogCounts();
  rep = await replicacheForTesting('log-level', {
    logLevel: 'debug',
    logSinks,
  });
  await rep.query(() => 42);
  for (const counts of logCounts) {
    expect(counts.info).to.be.greaterThan(0);
    expect(counts.info).to.be.greaterThan(0);
  }
  expectNoLogsToConsole();
  await rep.close();
});

test('mem store', async () => {
  let rep = await replicacheForTesting('mem', {
    mutators: {addData},
  });
  const add = rep.mutate.addData;
  await add({a: 42});
  expect(await rep.query(tx => tx.get('a'))).to.equal(42);
  await rep.close();

  // Open again and test that we lost the data
  rep = await replicacheForTesting('mem');
  expect(await rep.query(tx => tx.get('a'))).to.equal(undefined);
});

test('isEmpty', async () => {
  const rep = await replicacheForTesting('test-is-empty', {
    mutators: {
      addData,
      del: (tx: WriteTransaction, key: string) => tx.del(key),
      mut: async tx => {
        expect(await tx.isEmpty()).to.equal(false);

        await tx.del('c');
        expect(await tx.isEmpty()).to.equal(false);

        await tx.del('a');
        expect(await tx.isEmpty()).to.equal(true);

        await tx.put('d', 4);
        expect(await tx.isEmpty()).to.equal(false);
      },
    },
  });
  const {addData: add, del, mut} = rep.mutate;

  async function t(expected: boolean) {
    expect(await rep?.query(tx => tx.isEmpty())).to.equal(expected);
  }

  await t(true);

  await add({a: 1});
  await t(false);

  await add({b: 2, c: 3});
  await t(false);

  await del('b');
  await t(false);

  await mut();

  await t(false);
});

test('onSync', async () => {
  const pullURL = 'https://pull.com/pull';
  const pushURL = 'https://push.com/push';

  const rep = await replicacheForTesting('onSync', {
    pullURL,
    pushURL,
    pushDelay: 5,
    mutators: {addData},
  });
  const add = rep.mutate.addData;

  const onSync = sinon.fake();
  rep.onSync = onSync;

  expect(onSync.callCount).to.equal(0);

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 2,
    patch: [],
  });
  rep.pull();
  await tickAFewTimes(15);

  expect(onSync.callCount).to.equal(2);
  expect(onSync.getCall(0).args[0]).to.be.true;
  expect(onSync.getCall(1).args[0]).to.be.false;

  onSync.resetHistory();
  fetchMock.postOnce(pushURL, {});
  await add({a: 'a'});
  await tickAFewTimes();

  expect(onSync.callCount).to.equal(2);
  expect(onSync.getCall(0).args[0]).to.be.true;
  expect(onSync.getCall(1).args[0]).to.be.false;

  fetchMock.postOnce(pushURL, {});
  onSync.resetHistory();
  await add({b: 'b'});
  await tickAFewTimes();
  expect(onSync.callCount).to.equal(2);
  expect(onSync.getCall(0).args[0]).to.be.true;
  expect(onSync.getCall(1).args[0]).to.be.false;

  {
    // Try with reauth
    const consoleErrorStub = sinon.stub(console, 'error');
    fetchMock.postOnce(pushURL, {body: 'xxx', status: httpStatusUnauthorized});
    onSync.resetHistory();
    rep.getAuth = () => {
      // Next time it is going to be fine
      fetchMock.postOnce({url: pushURL, headers: {authorization: 'ok'}}, {});
      return 'ok';
    };

    await add({c: 'c'});

    await tickUntil(() => onSync.callCount >= 4);

    expectConsoleLogContextStub(
      rep.name,
      consoleErrorStub.firstCall,
      'Got error response from server (https://push.com/push) doing push: 401: xxx',
    );

    expect(onSync.callCount).to.equal(4);
    expect(onSync.getCall(0).args[0]).to.be.true;
    expect(onSync.getCall(1).args[0]).to.be.false;
    expect(onSync.getCall(2).args[0]).to.be.true;
    expect(onSync.getCall(3).args[0]).to.be.false;
  }

  rep.onSync = null;
  onSync.resetHistory();
  fetchMock.postOnce(pushURL, {});
  expect(onSync.callCount).to.equal(0);
});

test('push timing', async () => {
  const pushURL = 'https://push.com/push';
  const pushDelay = 5;

  const rep = await replicacheForTesting('push-timing', {
    pushURL,
    pushDelay,
    mutators: {addData},
  });

  const invokePushSpy = sinon.spy(rep, 'invokePush');

  const add = rep.mutate.addData;

  fetchMock.post(pushURL, {});
  await add({a: 0});
  await tickAFewTimes();

  const pushCallCount = () => {
    const rv = invokePushSpy.callCount;
    invokePushSpy.resetHistory();
    return rv;
  };

  expect(pushCallCount()).to.equal(1);

  // This will schedule push in pushDelay ms
  await add({a: 1});
  await add({b: 2});
  await add({c: 3});
  await add({d: 4});

  expect(pushCallCount()).to.equal(0);

  await clock.tickAsync(pushDelay + 10);

  expect(pushCallCount()).to.equal(1);

  const p1 = add({e: 5});
  const p2 = add({f: 6});
  const p3 = add({g: 7});

  expect(pushCallCount()).to.equal(0);

  await tickAFewTimes();
  await p1;
  expect(pushCallCount()).to.equal(1);
  await tickAFewTimes();
  await p2;
  expect(pushCallCount()).to.equal(0);
  await tickAFewTimes();
  await p3;
  expect(pushCallCount()).to.equal(0);
});

test('push and pull concurrently', async () => {
  const pushURL = 'https://push.com/push';
  const pullURL = 'https://pull.com/pull';

  const rep = await replicacheForTesting('concurrently', {
    pullURL,
    pushURL,
    pushDelay: 10,
    mutators: {addData},
  });

  const beginPullSpy = sinon.spy(rep, 'beginPull');
  const commitSpy = sinon.spy(db.Write.prototype, 'commitWithChangedKeys');
  const invokePushSpy = sinon.spy(rep, 'invokePush');
  const putSpy = sinon.spy(WriteTransactionImpl.prototype, 'put');

  function resetSpies() {
    beginPullSpy.resetHistory();
    commitSpy.resetHistory();
    invokePushSpy.resetHistory();
    putSpy.resetHistory();
  }

  const callCounts = () => {
    const rv = {
      beginPull: beginPullSpy.callCount,
      commit: commitSpy.callCount,
      invokePush: invokePushSpy.callCount,
      put: putSpy.callCount,
    };
    resetSpies();
    return rv;
  };

  const add = rep.mutate.addData;

  const requests: string[] = [];

  fetchMock.post(pushURL, async () => {
    requests.push(pushURL);
    return {};
  });
  fetchMock.post(pullURL, () => {
    requests.push(pullURL);
    return {lastMutationID: 0, patch: []};
  });

  await add({a: 0});
  resetSpies();

  await add({b: 1});
  rep.pull();

  await clock.tickAsync(10);

  // Only one push at a time but we want push and pull to be concurrent.
  expect(callCounts()).to.deep.equal({
    beginPull: 1,
    commit: 1,
    invokePush: 1,
    put: 1,
  });

  await tickAFewTimes();

  expect(requests).to.deep.equal([pullURL, pushURL]);

  await tickAFewTimes();

  expect(requests).to.deep.equal([pullURL, pushURL]);

  expect(callCounts()).to.deep.equal({
    beginPull: 0,
    commit: 0,
    invokePush: 0,
    put: 0,
  });
});

test('schemaVersion pull', async () => {
  const schemaVersion = 'testing-pull';

  const rep = await replicacheForTesting('schema-version-pull', {
    schemaVersion,
  });

  rep.pull();
  await tickAFewTimes();

  const req = await fetchMock.lastCall().request.json();
  expect(req.schemaVersion).to.deep.equal(schemaVersion);
});

test('schemaVersion push', async () => {
  const pushURL = 'https://push.com/push';
  const schemaVersion = 'testing-push';

  const rep = await replicacheForTesting('schema-version-push', {
    pushURL,
    schemaVersion,
    pushDelay: 1,
    mutators: {addData},
  });

  const add = rep.mutate.addData;
  await add({a: 1});

  fetchMock.post(pushURL, {});
  await tickAFewTimes();

  const req = await fetchMock.lastCall().request.json();
  expect(req.schemaVersion).to.deep.equal(schemaVersion);
});

test('clientID', async () => {
  const re =
    /^[0-9:A-z]{8}-[0-9:A-z]{4}-4[0-9:A-z]{3}-[0-9:A-z]{4}-[0-9:A-z]{12}$/;

  let rep = await replicacheForTesting('clientID');
  const clientID = await rep.clientID;
  expect(clientID).to.match(re);
  await rep.close();

  const rep2 = await replicacheForTesting('clientID2');
  const clientID2 = await rep2.clientID;
  expect(clientID2).to.match(re);
  expect(clientID2).to.not.equal(clientID);

  rep = await replicacheForTesting('clientID');
  const clientID3 = await rep.clientID;
  expect(clientID3).to.match(re);
  // With SDD we never reuse client IDs.
  expect(clientID3).to.not.equal(clientID);

  const rep4 = new Replicache({
    licenseKey: TEST_LICENSE_KEY,
    name: 'clientID4',
    pullInterval: null,
  });
  const clientID4 = await rep4.clientID;
  expect(clientID4).to.match(re);
  await rep4.close();
});

test('profileID', async () => {
  const re = /^p.+/; // More specific re tested in IdbDatabase.test.ts.

  const rep = await replicacheForTesting('clientID');
  const profileID = await rep.profileID;
  expect(profileID).to.not.equal(await rep.clientID);
  expect(profileID).to.match(re);
  await rep.close();

  const rep2 = await replicacheForTesting('clientID2');
  const profileID2 = await rep2.profileID;
  expect(profileID2).to.equal(profileID);

  const rep3 = new Replicache({
    licenseKey: TEST_LICENSE_KEY,
    name: 'clientID3',
  });
  const profileID3 = await rep3.profileID;
  expect(profileID3).to.equal(profileID);
  await rep3.close();
});

test('pull and index update', async () => {
  const pullURL = 'https://pull.com/rep';
  const rep = await replicacheForTesting('pull-and-index-update', {
    pullURL,
  });

  const indexName = 'idx1';
  let lastMutationID = 0;

  async function testPull(opt: {
    patch: PatchOperation[];
    expectedResult: JSONValue;
  }) {
    let pullDone = false;
    fetchMock.post(pullURL, () => {
      pullDone = true;
      return {
        lastMutationID: lastMutationID++,
        patch: opt.patch,
      };
    });

    rep.pull();

    await tickUntil(() => pullDone);
    await tickAFewTimes();

    const actualResult = await rep.query(tx =>
      tx.scan({indexName}).entries().toArray(),
    );
    expect(actualResult).to.deep.equal(opt.expectedResult);
  }

  await rep.createIndex({name: indexName, jsonPointer: '/id'});

  await testPull({patch: [], expectedResult: []});

  await testPull({
    patch: [
      {
        op: 'put',
        key: 'a1',
        value: {id: 'a-1', x: 1},
      },
    ],
    expectedResult: [
      [
        ['a-1', 'a1'],
        {
          id: 'a-1',
          x: 1,
        },
      ],
    ],
  });

  // Change value for existing key
  await testPull({
    patch: [
      {
        op: 'put',
        key: 'a1',
        value: {id: 'a-1', x: 2},
      },
    ],
    expectedResult: [
      [
        ['a-1', 'a1'],
        {
          id: 'a-1',
          x: 2,
        },
      ],
    ],
  });

  // Del
  await testPull({
    patch: [
      {
        op: 'del',
        key: 'a1',
      },
    ],
    expectedResult: [],
  });
});

async function tickUntilTimeIs(time: number, tick = 10) {
  while (Date.now() < time) {
    await clock.tickAsync(tick);
  }
}

test('pull mutate options', async () => {
  const pullURL = 'https://diff.com/pull';
  const rep = await replicacheForTesting('pull-mutate-options', {
    pullURL,
  });

  const log: number[] = [];

  fetchMock.post(pullURL, () => {
    log.push(Date.now());
    return {
      cookie: '',
      lastMutationID: 2,
      patch: [],
    };
  });

  await tickUntilTimeIs(1000);

  while (Date.now() < 1150) {
    rep.pull();
    await clock.tickAsync(10);
  }

  rep.requestOptions.minDelayMs = 500;

  while (Date.now() < 2000) {
    rep.pull();
    await clock.tickAsync(100);
  }

  rep.requestOptions.minDelayMs = 25;

  while (Date.now() < 2500) {
    rep.pull();
    await clock.tickAsync(5);
  }

  expect(log).to.deep.equal([
    1000, 1030, 1060, 1090, 1120, 1150, 1180, 1680, 2180, 2205, 2230, 2255,
    2280, 2305, 2330, 2355, 2380, 2405, 2430, 2455, 2480,
  ]);
});

test('online', async () => {
  const pushURL = 'https://diff.com/push';
  const rep = await replicacheForTesting('online', {
    pushURL,
    pushDelay: 0,
    mutators: {addData},
  });

  const log: boolean[] = [];
  rep.onOnlineChange = b => {
    log.push(b);
  };

  const consoleInfoStub = sinon.stub(console, 'info');

  fetchMock.post(pushURL, async () => {
    await sleep(10);
    return {throws: new Error('Simulate fetch error in push')};
  });

  expect(rep.online).to.equal(true);
  expect(log).to.deep.equal([]);

  await rep.mutate.addData({a: 0});

  await tickAFewTimes();

  expect(rep.online).to.equal(false);
  expect(consoleInfoStub.callCount).to.be.greaterThan(0);
  expect(log).to.deep.equal([false]);

  consoleInfoStub.resetHistory();

  fetchMock.post(pushURL, {});
  await rep.mutate.addData({a: 1});

  await tickAFewTimes(20);

  expect(consoleInfoStub.callCount).to.equal(0);
  expect(rep.online).to.equal(true);
  expect(log).to.deep.equal([false, true]);
});

type LicenseKeyCheckTestCase = {
  licenseKey: string;
  enableLicensing?: boolean; // default true
  mockFetchParams: object | undefined;
  expectValid: boolean;
  expectDisable: boolean;
  expectFetchCalled: boolean;
};

// TODO(phritz) ick, export these urls from the licensing client.
const statusUrlMatcher = new RegExp(
  `${PROD_LICENSE_SERVER_URL}${LICENSE_STATUS_PATH.slice(1)}`,
);
const activeUrlMatcher = new RegExp(
  `${PROD_LICENSE_SERVER_URL}${LICENSE_ACTIVE_PATH.slice(1)}`,
);

async function licenseKeyCheckTest(tc: LicenseKeyCheckTestCase) {
  const consoleErrorStub = sinon.stub(console, 'error');
  const name = 'license-key-test';
  fetchMock.reset();
  fetchMock.post(activeUrlMatcher, 200);
  if (tc.expectFetchCalled) {
    fetchMock.postOnce(statusUrlMatcher, tc.mockFetchParams);
  }
  fetchMock.catch();

  const rep = await replicacheForTesting(
    name,
    tc.enableLicensing !== undefined
      ? {
          licenseKey: tc.licenseKey,
          enableLicensing: tc.enableLicensing,
        }
      : {licenseKey: tc.licenseKey},
  );

  expect(await rep.licenseValid()).to.equal(tc.expectValid);
  if (tc.expectDisable) {
    expect(rep.closed).to.be.true;
    expect(consoleErrorStub.lastCall.args[1]).to.match(/REPLICACHE DISABLED/);
  } else {
    expect(rep.closed).to.be.false;
  }
  if (!tc.expectValid) {
    expect(consoleErrorStub.getCall(0).args[1]).to.match(
      /REPLICACHE LICENSE NOT VALID/,
    );
  }
  expect(fetchMock.called(statusUrlMatcher)).to.equal(tc.expectFetchCalled);

  await rep.close();
}

test('empty licensing key is not valid and does not send status check', async () => {
  await licenseKeyCheckTest({
    licenseKey: '',
    mockFetchParams: undefined,
    expectValid: false,
    expectDisable: true,
    expectFetchCalled: false,
  });
});

test('test licensing key is valid and does not send status check', async () => {
  await licenseKeyCheckTest({
    licenseKey: TEST_LICENSE_KEY,
    mockFetchParams: undefined,
    expectValid: true,
    expectDisable: false,
    expectFetchCalled: false,
  });
});

test('test when internal option enableLicensing is false any key is valid and does not send status check', async () => {
  await licenseKeyCheckTest({
    licenseKey: 'any-random-key',
    enableLicensing: false,
    mockFetchParams: undefined,
    expectValid: true,
    expectDisable: false,
    expectFetchCalled: false,
  });
});

test('licensing key is valid if check returns valid', async () => {
  await licenseKeyCheckTest({
    licenseKey: 'l123validkey',
    mockFetchParams: {
      body: {
        status: LicenseStatus.Valid,
        disable: false,
        pleaseUpdate: false,
      },
    },
    expectValid: true,
    expectDisable: false,
    expectFetchCalled: true,
  });
});

test('licensing key is not valid if check returns invalid', async () => {
  await licenseKeyCheckTest({
    licenseKey: 'l123keyreturnsINVALID',
    mockFetchParams: {
      body: {
        status: LicenseStatus.Invalid,
        disable: false,
        pleaseUpdate: false,
      },
    },
    expectValid: false,
    expectDisable: false,
    expectFetchCalled: true,
  });
});

test('Replicache is disabled if check returns disable', async () => {
  await licenseKeyCheckTest({
    licenseKey: 'l123keyreturnsINVALID',
    mockFetchParams: {
      body: {
        status: LicenseStatus.Invalid,
        disable: true,
        pleaseUpdate: false,
      },
    },
    expectValid: false,
    expectDisable: true,
    expectFetchCalled: true,
  });
});

test('licensing key is valid if check throws', async () => {
  await licenseKeyCheckTest({
    licenseKey: 'l123keythrows',
    mockFetchParams: {
      throws: new Error('kaboom (this is a fake error in a test)'),
    },
    expectValid: true,
    expectDisable: false,
    expectFetchCalled: true,
  });
});

test('licensing key is valid if check returns non-200', async () => {
  await licenseKeyCheckTest({
    licenseKey: 'lkeyreturns500',
    mockFetchParams: {
      status: 500,
    },
    expectValid: true,
    expectDisable: false,
    expectFetchCalled: true,
  });
});

type LicenseActiveTestCase = {
  licenseKey: string | undefined;
  enableLicensing?: boolean; // default true
  mockFetchParams: object | undefined;
  expectActive: boolean;
  expectFetchCalled: boolean;
};

async function licenseActiveTest(tc: LicenseActiveTestCase) {
  // Silence console.error
  sinon.stub(console, 'error');
  // TODO: assert we are getting the correct logs

  fetchMock.reset();
  fetchMock.post(
    statusUrlMatcher,
    '{"status": "VALID", "disable": false, "pleaseUpdate": false}',
  );
  if (tc.expectFetchCalled) {
    fetchMock.postOnce(activeUrlMatcher, tc.mockFetchParams);
  }
  fetchMock.catch();
  const rep = await replicacheForTesting(
    'license-active-test',
    tc.enableLicensing !== undefined
      ? {
          licenseKey: tc.licenseKey,
          enableLicensing: tc.enableLicensing,
        }
      : {licenseKey: tc.licenseKey},
  );
  const licenseActive = await rep.licenseActive();
  expect(licenseActive).to.equal(tc.expectActive);
  expect(fetchMock.called(activeUrlMatcher)).to.equal(tc.expectFetchCalled);
  if (tc.expectFetchCalled && fetchMock.called(activeUrlMatcher)) {
    const got = JSON.parse(fetchMock.lastCall(activeUrlMatcher)[1].body);
    const {licenseKey, profileID} = got;
    expect(licenseKey).to.equal(tc.licenseKey);
    expect(profileID).to.equal(await rep.profileID);
  }
  // TODO(phritz) Should we test that it gets called repeatedly?
  await rep.close();
}

test('no licensing key is not active and does not send active pings', async () => {
  await licenseActiveTest({
    licenseKey: undefined,
    mockFetchParams: undefined,
    expectActive: false,
    expectFetchCalled: false,
  });
});

test('test licensing key is not active and does not send active pings', async () => {
  await licenseActiveTest({
    licenseKey: TEST_LICENSE_KEY,
    mockFetchParams: undefined,
    expectActive: false,
    expectFetchCalled: false,
  });
});

test('test when internal option enableLicensing is false any licensing key is not active and does not send active pings', async () => {
  await licenseActiveTest({
    licenseKey: 'any-random-key',
    enableLicensing: false,
    mockFetchParams: undefined,
    expectActive: false,
    expectFetchCalled: false,
  });
});

test('a non-empty, non-test licensing key is active and does send active pings', async () => {
  await licenseActiveTest({
    licenseKey: 'l123validkey',
    mockFetchParams: {
      status: 200,
      body: '{}',
    },
    expectActive: true,
    expectFetchCalled: true,
  });
});

test('overlapping open/close', async () => {
  const pullInterval = 60_000;
  const name = 'overlapping-open-close';

  const rep = new Replicache({
    licenseKey: TEST_LICENSE_KEY,
    name,
    pullInterval,
  });
  const p = rep.close();

  const rep2 = new Replicache({
    licenseKey: TEST_LICENSE_KEY,
    name,
    pullInterval,
  });
  const p2 = rep2.close();

  const rep3 = new Replicache({
    licenseKey: TEST_LICENSE_KEY,
    name,
    pullInterval,
  });
  const p3 = rep3.close();

  await p;
  await p2;
  await p3;

  {
    const rep = new Replicache({
      licenseKey: TEST_LICENSE_KEY,
      name,
      pullInterval,
    });
    await rep.clientID;
    const p = rep.close();
    const rep2 = new Replicache({
      licenseKey: TEST_LICENSE_KEY,
      name,
      pullInterval,
    });
    await rep2.clientID;
    const p2 = rep2.close();
    await p;
    await p2;
  }
});

test('experiment KV Store', async () => {
  const store = new MemStoreWithCounters();
  const rep = await replicacheForTesting('experiment-kv-store', {
    experimentalKVStore: store,
    mutators: {addData},
  });

  expect(store.readCount).to.equal(3, 'readCount');
  expect(store.writeCount).to.equal(1, 'writeCount');
  expect(store.closeCount).to.equal(0, 'closeCount');
  store.resetCounters();

  const b = await rep.query(tx => tx.has('foo'));
  expect(b).to.be.false;

  expect(store.readCount).to.equal(1, 'readCount');
  expect(store.writeCount).to.equal(0, 'writeCount');
  expect(store.closeCount).to.equal(0, 'closeCount');
  store.resetCounters();

  await rep.mutate.addData({foo: 'bar'});
  expect(store.readCount).to.equal(0, 'readCount');
  expect(store.writeCount).to.equal(0, 'writeCount');
  expect(store.closeCount).to.equal(0, 'closeCount');
  store.resetCounters();

  await rep.persist();
  expect(store.readCount).to.equal(2, 'readCount');
  expect(store.writeCount).to.equal(1, 'writeCount');
  expect(store.closeCount).to.equal(0, 'closeCount');
  store.resetCounters();

  await rep.close();
  expect(store.readCount).to.equal(0, 'readCount');
  expect(store.writeCount).to.equal(0, 'writeCount');
  expect(store.closeCount).to.equal(1, 'closeCount');
});

function findPropertyValue(
  obj: unknown,
  propertyName: string,
  propertyValue: unknown,
): unknown | undefined {
  if (typeof obj === 'object' && obj !== null) {
    const rec = obj as Record<string, unknown>;
    if (rec[propertyName] === propertyValue) {
      return rec;
    }

    let values: Iterable<unknown>;
    if (obj instanceof Set || obj instanceof Map || obj instanceof Array) {
      values = obj.values();
    } else {
      values = Object.values(rec);
    }
    for (const v of values) {
      const r = findPropertyValue(v, propertyName, propertyValue);
      if (r) {
        return r;
      }
    }
  }
  return undefined;
}

test('mutate args in mutation', async () => {
  // This tests that mutating the args in a mutation does not mutate the args we
  // store in the kv.Store.
  const store = new TestMemStore();
  const rep = await replicacheForTesting('mutate-args-in-mutation', {
    experimentalKVStore: store,
    mutators: {
      async mutArgs(tx, args: {v: number}) {
        args.v = 42;
        await tx.put('v', args.v);
      },
    },
  });

  await rep.mutate.mutArgs({v: 1});

  // Safari does not have requestIdleTimeout so it waits for a second.
  await clock.tickAsync(1000);

  const o = findPropertyValue(store.map(), 'mutatorName', 'mutArgs');
  expect((o as {mutatorArgsJSON?: unknown}).mutatorArgsJSON).to.deep.equal({
    v: 1,
  });
});

test('client ID is set correctly on transactions', async () => {
  const rep = await replicacheForTesting(
    'client-id-is-set-correctly-on-transactions',
    {
      mutators: {
        async expectClientID(tx, expectedClientID: string) {
          expect(tx.clientID).to.equal(expectedClientID);
        },
      },
    },
  );

  const repClientID = await rep.clientID;

  await rep.query(tx => {
    expect(tx.clientID).to.equal(repClientID);
  });

  await rep.mutate.expectClientID(repClientID);
});

test('mutation timestamps are immutable', async () => {
  let pending: Mutation[] = [];
  const rep = await replicacheForTesting('mutation-timestamps-are-immutable', {
    mutators: {
      foo: async (tx, _: JSONValue) => {
        await tx.put('foo', 'bar');
      },
    },
    pusher: async (req: Request) => {
      const parsed = await req.json();
      pending = parsed.mutations as Mutation[];
      return {
        errorMessage: '',
        httpStatusCode: 200,
      };
    },
  });

  // Create a mutation and verify it has been assigned current time.
  await rep.mutate.foo(null);
  await rep.invokePush();
  expect(pending).deep.equal([
    {
      id: 1,
      name: 'foo',
      args: null,
      timestamp: 100,
    },
  ]);

  // Move clock forward, then cause a rebase, the pending mutation will
  // replay internally.
  pending = [];
  await tickAFewTimes();

  await rep.poke({
    baseCookie: null,
    pullResponse: {
      lastMutationID: 0,
      patch: [
        {
          op: 'put',
          key: 'hot',
          value: 'dog',
        },
      ],
      cookie: 1,
    },
  });

  // Verify rebase did occur by checking for the new value.
  const val = await rep.query(async tx => await tx.get('hot'));
  expect(val).equal('dog');

  // Check that mutation timestamp did not change
  await rep.invokePush();
  expect(pending).deep.equal([
    {
      id: 1,
      name: 'foo',
      args: null,
      timestamp: 100,
    },
  ]);
});

// Define this here to prevent issues with building docs
type DocumentVisibilityState = 'hidden' | 'visible';

suite('check for client not found in visibilitychange', () => {
  const t = (visibilityState: DocumentVisibilityState, called: boolean) => {
    test('visibilityState: ' + visibilityState, async () => {
      const consoleErrorStub = sinon.stub(console, 'error');
      sinon.stub(document, 'visibilityState').get(() => visibilityState);

      const rep = await replicacheForTesting(
        `check-for-client-not-found-in-visibilitychange-${visibilityState}`,
      );

      const onClientStateNotFound = sinon.fake();
      rep.onClientStateNotFound = onClientStateNotFound;

      const clientID = await rep.clientID;
      await deleteClientForTesting(clientID, rep.perdag);

      consoleErrorStub.resetHistory();

      document.dispatchEvent(new Event('visibilitychange'));

      await tickAFewTimes();

      expect(onClientStateNotFound.called).to.equal(called);
      if (called) {
        expectLogContext(
          consoleErrorStub,
          0,
          rep,
          `Client state not found, clientID: ${clientID}`,
        );
      }

      await rep.close();
    });
  };

  t('hidden', false);
  t('visible', true);
});

test('scan in write transaction', async () => {
  let x = 0;
  const rep = await replicacheForTesting('scan-before-commit', {
    mutators: {
      async test(tx, v: number) {
        await tx.put('a', v);
        expect(await tx.scan().toArray()).to.deep.equal([v]);
        x++;
      },
    },
  });

  await rep.mutate.test(42);

  expect(x).to.equal(1);
});
