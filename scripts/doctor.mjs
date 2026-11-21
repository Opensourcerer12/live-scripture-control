/**
 * "Is this PC ready?" — run before a service, or right after moving the app to another PC.
 *
 *   node scripts/doctor.mjs
 *
 * Read-only. The desktop app runs the same checks from File → Check setup.
 */
import { runChecks } from "../server/checks.mjs"

const { lines, problems } = await runChecks()

console.log("")
console.log("  LIVE SCRIPTURE CONTROL — setup check")
console.log("")
console.log(lines.map((line) => `  ${line}`).join("\n"))
console.log("")
console.log(problems ? `  ${problems} thing(s) to look at.` : "  Everything checks out.")
console.log("")
