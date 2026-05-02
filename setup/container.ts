/**
 * Step: container — Build container image and verify with test run.
 * Replaces 03-setup-container.sh
 */
import { execSync, spawnSync } from 'child_process';
import path from 'path';

import { log } from '../src/log.js';
import { getDefaultContainerImage } from '../src/install-slug.js';
import { commandExists } from './platform.js';
import { emitStatus } from './status.js';

const SUPPORTED_RUNTIMES = ['docker', 'podman'] as const;
type SupportedRuntime = (typeof SUPPORTED_RUNTIMES)[number];

/**
 * For Docker (daemon-based), verify the daemon is reachable. Podman is
 * daemonless — no check needed, just the binary.
 */
function checkDockerDaemon(): 'ok' | 'no-permission' | 'no-daemon' {
  const res = spawnSync('docker', ['info'], { encoding: 'utf-8' });
  if (res.status === 0) return 'ok';
  const err = `${res.stderr ?? ''}\n${res.stdout ?? ''}`;
  if (/permission denied/i.test(err)) return 'no-permission';
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
      HINT: `Install ${runtime} before running setup.`,
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  // Docker needs a running daemon; Podman is daemonless — no check needed.
  if (runtime === 'docker') {
    const daemonStatus = checkDockerDaemon();
    if (daemonStatus !== 'ok') {
      const error = daemonStatus === 'no-permission' ? 'docker_group_not_active' : 'runtime_not_available';
      const hint =
        daemonStatus === 'no-permission'
          ? 'Ensure your user is in the docker group and log back in: sudo usermod -aG docker $USER'
          : 'Ensure the Docker daemon is running before running setup.';
      emitStatus('SETUP_CONTAINER', {
        RUNTIME: runtime,
        IMAGE: image,
        BUILD_OK: false,
        TEST_OK: false,
        STATUS: 'failed',
        ERROR: error,
        HINT: hint,
        LOG: 'logs/setup.log',
      });
      process.exit(2);
    }
  }

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

  // Build — stdio inherit so the parent setup runner can tail output in a
  // rolling window rather than buffering everything until completion.
  let buildOk = false;
  log.info('Building container', { runtime, buildArgs });
  const buildRes = spawnSync(
    runtime,
    ['build', ...buildArgs.flatMap((a) => a.split(' ')), '-t', image, '.'],
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
        `echo '{}' | ${runtime} run -i --rm --entrypoint /bin/echo ${image} "Container OK"`,
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
