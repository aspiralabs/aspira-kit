import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { evaluationSchema, scoreBenchmark } from '../agent/lib/benchmark.ts'
import type { PipelineResult } from '../agent/lib/pipeline.ts'

const [dir, evaluationPath] = process.argv.slice(2)
if (!dir || !evaluationPath) throw new Error('Usage: pnpm score <run-directory> <evaluation.json>')
const report = JSON.parse(await readFile(resolve(dir, 'trace/review.json'), 'utf8')) as PipelineResult & { totalMs: number }
const candidate = await readFile(resolve(dir, 'spec.reviewed.md'), 'utf8').catch(() => '')
const evaluation = evaluationSchema.parse(JSON.parse(await readFile(evaluationPath, 'utf8')))
const score = scoreBenchmark(report, candidate, evaluation)
console.log(JSON.stringify(score, null, 2))
if (!score.passed) process.exitCode = 1
