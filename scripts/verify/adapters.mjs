// scripts/verify/adapters.mjs
/**
 * One adapter per runner (spec §Adapters): the command that runs chosen files (or the whole suite,
 * `files: null`) or only some tests (`grep`: a name path, or a list of them), writing a report the matching parser reads.
 * `files` are relative to the suite's cwd; the command runs there.
 */
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJUnit, parseJestJson, parseXcresult, parseJsonLines } from './reports.mjs'

export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A name path's last part — what most runners' name filters match. */
export const leafOf = (name) => String(name).split(/ > | › /).pop()
/** `grep` is one name path or a list of them (a batched re-run): their escaped leaves, deduped. */
const leaves = (grep) => [...new Set([].concat(grep ?? []).map((g) => re(leafOf(g))))]
const alt = (xs) => (xs.length > 1 ? `(${xs.join('|')})` : xs[0])
const join = (...parts) => parts.filter(Boolean).join(' ')
const NODE_REPORTER = fileURLToPath(new URL('./node-reporter.mjs', import.meta.url))

export const ADAPTERS = {
  'node-test': {
    command: ({ suite, files, grep, report }) =>
      join('node --test', `--test-reporter=${q(NODE_REPORTER)}`, `--test-reporter-destination=${q(report)}`, suite.args, ...leaves(grep).map((l) => `--test-name-pattern=${q(l)}`), ...(files ?? [suite.files]).map(q)),
    parse: parseJsonLines,
  },
  vitest: {
    command: ({ suite, files, grep, report }) => join('npx vitest run --reporter=junit', `--outputFile=${q(report)}`, suite.args, grep && `-t ${q(leaves(grep).join('|'))}`, ...(files ?? []).map(q)),
    parse: parseJUnit,
  },
  jest: {
    command: ({ suite, files, grep, report }) => join('npx jest --ci --json', `--outputFile=${q(report)}`, suite.args, grep && `-t ${q(leaves(grep).join('|'))}`, files && `--runTestsByPath ${files.map(q).join(' ')}`),
    parse: parseJestJson,
  },
  phpunit: {
    command: ({ suite, files, grep, report }) => {
      const cls = [...new Set((files ?? []).map((f) => re(basename(f, '.php'))))]
      const filter = grep ? (cls.length ? `${alt(cls)}::${alt(leaves(grep))}` : alt(leaves(grep))) : cls.length ? `(${cls.join('|')})` : null
      return join('./vendor/bin/phpunit', `--log-junit ${q(report)}`, suite.args, filter && `--filter ${q(filter)}`)
    },
    parse: parseJUnit,
  },
  xcodebuild: {
    command: ({ suite, files, grep, pairs, report }) => {
      const bundle = `${report}.xcresult`
      // A batch names (file, test) pairs: crossing its files with its names would ask for tests that don't exist.
      const one = (f, g) => `-only-testing:${q(`${suite.target}/${basename(f, '.swift')}${g ? `/${leafOf(g).replace(/\(\)$/, '')}` : ''}`)}`
      const only = pairs ? [...new Set(pairs.map((p) => one(p.file, p.name)))] : (files ?? []).flatMap((f) => (grep ? [].concat(grep).map((g) => one(f, g)) : [one(f)]))
      const dest = suite.destination ? q(suite.destination) : '"id=$SIMULATOR_UDID"'
      return `rm -rf ${q(bundle)}; ${join('xcodebuild test', `-scheme ${q(suite.scheme)}`, `-destination ${dest}`, `-resultBundlePath ${q(bundle)}`, suite.args, ...only)}; rc=$?; xcrun xcresulttool get test-results tests --path ${q(bundle)} > ${q(report)}; exit $rc`
    },
    parse: (text) => parseXcresult(text),
  },
  playwright: {
    command: ({ suite, files, grep, report }) => join(`PLAYWRIGHT_JUNIT_OUTPUT_NAME=${q(report)} npx playwright test --reporter=junit`, grep && `--grep ${q(leaves(grep).join('|'))}`, suite.args, ...(files ?? []).map(q)),
    parse: parseJUnit,
  },
  junit: {
    command: ({ suite, files, grep }) =>
      suite.command
        .replaceAll('{files}', (files ?? (suite.files ? [suite.files] : [])).map(q).join(' '))
        .replaceAll('{grep}', grep ? q(leaves(grep).join('|')) : ''),
    parse: parseJUnit,
    /** The project's own report path, not one the verifier picks. */
    reportPath: (suite, cwd) => `${cwd}/${suite.report}`,
  },
}
