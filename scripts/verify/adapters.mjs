// scripts/verify/adapters.mjs
/**
 * One adapter per runner (spec §Adapters): the command that runs chosen files (or the whole suite,
 * `files: null`) or one test (`grep`: its name path), writing a report the matching parser reads.
 * `files` are relative to the suite's cwd; the command runs there.
 */
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJUnit, parseJestJson, parseXcresult, parseJsonLines } from './reports.mjs'

export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A name path's last part — what most runners' name filters match. */
export const leafOf = (name) => String(name).split(/ > | › /).pop()
const join = (...parts) => parts.filter(Boolean).join(' ')
const NODE_REPORTER = fileURLToPath(new URL('./node-reporter.mjs', import.meta.url))

export const ADAPTERS = {
  'node-test': {
    command: ({ suite, files, grep, report }) =>
      join('node --test', `--test-reporter=${q(NODE_REPORTER)}`, `--test-reporter-destination=${q(report)}`, suite.args, grep && `--test-name-pattern=${q(re(leafOf(grep)))}`, ...(files ?? [suite.files]).map(q)),
    parse: parseJsonLines,
  },
  vitest: {
    command: ({ suite, files, grep, report }) => join('npx vitest run --reporter=junit', `--outputFile=${q(report)}`, suite.args, grep && `-t ${q(re(leafOf(grep)))}`, ...(files ?? []).map(q)),
    parse: parseJUnit,
  },
  jest: {
    command: ({ suite, files, grep, report }) => join('npx jest --ci --json', `--outputFile=${q(report)}`, suite.args, grep && `-t ${q(re(leafOf(grep)))}`, files && `--runTestsByPath ${files.map(q).join(' ')}`),
    parse: parseJestJson,
  },
  phpunit: {
    command: ({ suite, files, grep, report }) => {
      const cls = (files ?? []).map((f) => basename(f, '.php'))
      const filter = grep ? (cls.length ? `${re(cls[0])}::${re(leafOf(grep))}` : re(leafOf(grep))) : cls.length ? `(${cls.map(re).join('|')})` : null
      return join('./vendor/bin/phpunit', `--log-junit ${q(report)}`, suite.args, filter && `--filter ${q(filter)}`)
    },
    parse: parseJUnit,
  },
  xcodebuild: {
    command: ({ suite, files, grep, report }) => {
      const bundle = `${report}.xcresult`
      const only = (files ?? []).map((f) => `-only-testing:${q(`${suite.target}/${basename(f, '.swift')}${grep ? `/${leafOf(grep).replace(/\(\)$/, '')}` : ''}`)}`)
      const dest = suite.destination ? q(suite.destination) : '"id=$SIMULATOR_UDID"'
      return `rm -rf ${q(bundle)}; ${join('xcodebuild test', `-scheme ${q(suite.scheme)}`, `-destination ${dest}`, `-resultBundlePath ${q(bundle)}`, suite.args, ...only)}; rc=$?; xcrun xcresulttool get test-results tests --path ${q(bundle)} > ${q(report)}; exit $rc`
    },
    parse: (text) => parseXcresult(text),
  },
  playwright: {
    command: ({ suite, files, grep, report }) => join(`PLAYWRIGHT_JUNIT_OUTPUT_NAME=${q(report)} npx playwright test --reporter=junit`, grep && `--grep ${q(re(leafOf(grep)))}`, suite.args, ...(files ?? []).map(q)),
    parse: parseJUnit,
  },
  junit: {
    command: ({ suite, files, grep }) =>
      suite.command
        .replaceAll('{files}', (files ?? (suite.files ? [suite.files] : [])).map(q).join(' '))
        .replaceAll('{grep}', grep ? q(re(leafOf(grep))) : ''),
    parse: parseJUnit,
    /** The project's own report path, not one the verifier picks. */
    reportPath: (suite, cwd) => `${cwd}/${suite.report}`,
  },
}
