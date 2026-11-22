/**
 * Completes the Next.js standalone build.
 *
 * `output: 'standalone'` writes a server and the modules webpack traced into
 * it. Three things it needs at runtime are not in that trace, and each one
 * fails in a way that is easy to miss because the server still starts:
 *
 *   .next/static, public  Next leaves these to the deployment. Without them
 *                         every page renders unstyled, with no client-side
 *                         JavaScript, and sw.js 404s so the member app
 *                         cannot install.
 *   Prisma query engine   Not traced. Every page that touches the database
 *                         throws PrismaClientInitializationError; static
 *                         pages still answer 200.
 *   @node-rs/argon2       Marked external in next.config so Node loads the
 *                         prebuilt binary instead of webpack parsing a
 *                         .node file. External means untraced, so nothing
 *                         copies it, and login throws Cannot find module.
 *
 * The last two live under pnpm directories whose names carry version hashes,
 * and the right argon2 binary depends on the machine building. So both are
 * discovered here rather than written down: whatever `pnpm install` put in
 * place is what gets copied.
 *
 *   node scripts/copy-standalone.mjs
 */
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every path below is relative to the repository root. turbo runs each
// package's build with that package as the working directory, so the root is
// taken from this file's own location rather than from wherever it was run.
process.chdir(join(dirname(fileURLToPath(import.meta.url)), '..'));

const web = 'apps/web';
const standalone = join(web, '.next', 'standalone');
// The standalone tree mirrors the workspace, so the server sits at the same
// path inside it that the package occupies in the repository.
const root = join(standalone, web);
const store = 'node_modules/.pnpm';

if (!existsSync(root)) {
    console.error(`No standalone build at ${root}. Run \`next build\` first.`);
    process.exit(1);
}

function copy(from, to) {
    cpSync(from, to, { recursive: true, dereference: true });
    console.log(`copied ${from}`);
}

for (const [from, to] of [
    [join(web, '.next', 'static'), join(root, '.next', 'static')],
    [join(web, 'public'), join(root, 'public')],
  ]) {
    if (existsSync(from)) copy(from, to);
    else console.log(`skipped ${from} (not present)`);
}

/** Every package directory under the pnpm store whose name starts with prefix. */
function fromStore(prefix) {
    if (!existsSync(store)) return [];
    const found = [];
    for (const entry of readdirSync(store)) {
          if (!entry.startsWith(prefix)) continue;
          found.push(join(store, entry, 'node_modules'));
    }
    return found;
}

// Prisma: copied to <app>/.prisma/client, one of the paths Prisma itself
// searches, so the pnpm hash never has to be named.
const prisma = fromStore('@prisma+client@')
  .map((dir) => join(dir, '.prisma', 'client'))
  .find(existsSync);

if (!prisma) {
    console.error('No generated Prisma client found. Run `pnpm db:generate` first.');
    process.exit(1);
}
copy(prisma, join(root, '.prisma', 'client'));

// argon2: the wrapper and whichever platform binary this machine installed.
let natives = 0;
for (const dir of fromStore('@node-rs+argon2')) {
    const scope = join(dir, '@node-rs');
    if (!existsSync(scope)) continue;
    for (const pkg of readdirSync(scope)) {
          copy(join(scope, pkg), join(standalone, 'node_modules', '@node-rs', pkg));
          natives += 1;
    }
}

if (natives === 0) {
    console.error('No @node-rs/argon2 found. Run `pnpm install` first.');
    process.exit(1);
}
