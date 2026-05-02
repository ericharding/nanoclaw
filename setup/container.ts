/**
 * Step: container — Build container image and verify with test run.
 * Replaces 03-setup-container.sh
 */
import { execSync, spawnSync } from 'child_process';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';

import { log } from '../src/log.js';
import { getDefaultContainerImage } from '../src/install-slug.js';
import { commandExists, getPlatform } from './platform.js';
import { emitStatus } from './status.js';

type RuntimeStatus = 'ok' | 'no-permission' | 'no-daemon' | 'other';

const SUPPORTED_RUNTIMES = ['docker', 'podman'] as const;
type SupportedRuntime = (typeof SUPPORTED_RUNTIMES)[number];

function runtimeStatus(bin: string): RuntimeStatus {
  const res = spawnSync(bin, ['info'], { encoding: 'utf-8' });
  if (res.status === 0) return 'ok';
  const err = `${res.stderr ?? ''}\n${res.stdout ?? ''}`;
  if (/permission denied/i.test(err)) return 'no-permission';
  if (/cannot connect|is the docker daemon running|no such file/i.test(err)) return 'no-daemon';
  return 'other';
}

/**
 * Try to start the container runtime if it's installed but idle. Poll up to
 * 60s for the daemon to come up — but bail immediately if the socket is
 * reachable and only blocked by a group-permission error (Docker only), since
 * that won't resolve by waiting.
 */
async function tryStartRuntime(runtime: string): Promise<RuntimeStatus> {
  const platform = getPlatform();
  log.info(`${runtime} not running — attempting to start`, { platform });

  try {
    if (runtime === 'docker') {
      if (platform === 'macos') {
        execSync('open -a Docker', { stdio: 'ignore' });
      } else if (platform === 'linux') {
        execSync('sudo systemctl start docker', { stdio: 'inherit' });
      } else {
        return 'other';
      }
    } else if (runtime === 'podman') {
      if (platform === 'linux') {
        // Podman is rootless; start the user socket unit.
        execSync('systemctl --user start podman.socket', { stdio: 'inherit' });
      } else {
        return 'other';
      }
    } else {
      return 'other';
    }
  } catch (err) {
    log.warn('Start command failed', { err });
    return 'other';
  }

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const s = runtimeStatus(runtime);
    if (s === 'ok') {
      log.info(`${runtime} is up`);
      return 'ok';
    }
    if (s === 'no-permission') {
      log.info(`${runtime} daemon is up but socket is not accessible (group membership)`);
      return 'no-permission';
    }
  }
  log.warn(`${runtime} did not become ready within 60s`);
  return 'no-daemon';
}

function parseArgs(args: string[]): { runtime: string } {
  // Precedence: --runtime flag > CONTAINER_RUNTIME env > 'docker'
  let runtime = process.env.CONTAINER_RUNTIME || 'docker';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runtime' && args[i + 1]) {
      runtime = args[i + 1];
      i++;
    }
  }
  return { runtime };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { runtime } = parseArgs(args);
  const image = getDefaultContainerImage(projectRoot);
  const logFile = path.join(projectRoot, 'logs', 'setup.log');

  if (!SUPPORTED_RUNTIMES.includes(runtime as SupportedRuntime)) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'unknown_runtime',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  // Only attempt to auto-install Docker; Podman must be installed by the user.
  if (!commandExists(runtime)) {
    if (runtime === 'docker') {
      log.info('Docker not found — running setup/install-docker.sh');
      try {
        execSync('bash setup/install-docker.sh', { cwd: projectRoot, stdio: 'inherit' });
      } catch (err) {
        log.warn('install-docker.sh failed', { err });
      }
    } else {
      log.warn(`${runtime} not found — please install it before running setup`);
    }
  }

  if (!commandExists(runtime)) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'runtime_not_available',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  {
    let status = runtimeStatus(runtime);
    if (status !== 'ok') {
      status = await tryStartRuntime(runtime);
    }

    // Docker on Linux: socket is unreachable due to group perms — current
    // shell's supplementary groups are fixed at login, so `usermod -aG docker`
    // doesn't affect us until next login. Re-exec under `sg docker`.
    // Podman is rootless by default — no group membership required.
    if (
      runtime === 'docker' &&
      status === 'no-permission' &&
      getPlatform() === 'linux' &&
      commandExists('sg')
    ) {
      const inGroup = spawnSync('id', ['-nG'], { encoding: 'utf-8' });
      if (!(inGroup.stdout ?? '').split(/\s+/).includes('docker')) {
        log.info('Adding current user to docker group');
        spawnSync('sudo', ['usermod', '-aG', 'docker', process.env.USER ?? ''], {
          stdio: 'inherit',
        });
      }

      log.info('Re-executing container step under `sg docker`');
      const res = spawnSync(
        'sg',
        ['docker', '-c', 'pnpm exec tsx setup/index.ts --step container'],
        { cwd: projectRoot, stdio: 'inherit' },
      );
      process.exit(res.status ?? 1);
    }

    if (status !== 'ok') {
      const error =
        status === 'no-permission' ? 'docker_group_not_active' : 'runtime_not_available';
      emitStatus('SETUP_CONTAINER', {
        RUNTIME: runtime,
        IMAGE: image,
        BUILD_OK: false,
        TEST_OK: false,
        STATUS: 'failed',
        ERROR: error,
        LOG: 'logs/setup.log',
      });
      process.exit(2);
    }
  }

  const buildCmd = `${runtime} build`;
  const runCmd = runtime;

  // Build-args from .env. Only INSTALL_CJK_FONTS is passed through today.
  // Keeps /setup and ./container/build.sh in sync — both read the same source.
  const buildArgs: string[] = [];
  try {
    const fs = await import('fs');
    const envPath = path.join(projectRoot, '.env');
    if (fs.existsSync(envPath)) {
      const match = fs.readFileSync(envPath, 'utf-8').match(/^INSTALL_CJK_FONTS=(.+)$/m);
      const val = match?.[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (val === 'true') buildArgs.push('--build-arg INSTALL_CJK_FONTS=true');
    }
  } catch {
    // .env is optional; absence is normal on a fresh checkout
  }

  // Build — stdio inherit so the parent setup runner can tail docker's
  // per-step output and render it in a rolling window. Previously we used
  // execSync which buffered everything; users couldn't tell whether a
  // 3–10 minute build was making progress or hung.
  let buildOk = false;
  log.info('Building container', { runtime, buildArgs });
  const buildRes = spawnSync(
    buildCmd.split(' ')[0],
    [
      ...buildCmd.split(' ').slice(1),
      ...buildArgs.flatMap((a) => a.split(' ')),
      '-t',
      image,
      '.',
    ],
    {
      cwd: path.join(projectRoot, 'container'),
      stdio: 'inherit',
    },
  );
  if (buildRes.status === 0) {
    buildOk = true;
    log.info('Container build succeeded');
  } else {
    log.error('Container build failed', { exitCode: buildRes.status });
  }

  // Test
  let testOk = false;
  if (buildOk) {
    log.info('Testing container');
    try {
      const output = execSync(
        `echo '{}' | ${runCmd} run -i --rm --entrypoint /bin/echo ${image} "Container OK"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      testOk = output.includes('Container OK');
      log.info('Container test result', { testOk });
    } catch {
      log.error('Container test failed');
    }
  }

  const status = buildOk && testOk ? 'success' : 'failed';

  emitStatus('SETUP_CONTAINER', {
    RUNTIME: runtime,
    IMAGE: image,
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
