import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import stringArgv from "string-argv";

function req(name: string): string {
    return String(core.getInput(name, { required: true }) || "").trim();
}
function opt(name: string, def = ""): string {
    const v = String(core.getInput(name, { required: false }) ?? "").trim();
    return v.length ? v : def;
}

function ensureDir(p: string) {
    if (!fs.existsSync(p)) throw new Error(`working_directory does not exist: ${p}`);
    if (!fs.statSync(p).isDirectory()) throw new Error(`working_directory is not a directory: ${p}`);
}

async function installCli(cliVersion: string) {
    const pkg = cliVersion ? `codequill@${cliVersion}` : "codequill";
    core.info(`Installing CodeQuill CLI: ${pkg}`);
    await exec.exec("npm", ["i", "-g", pkg]);
    try { await exec.exec("codequill", ["--version"]); } catch { /* ignore */ }
}

async function runCli(args: string[], env: Record<string,string>) {
    core.info(`Running: codequill ${args.join(" ")}`);
    return await exec.getExecOutput("codequill", args, { env: { ...process.env, ...env } as Record<string, string> });
}

async function closeIssueWithComment(params: {
    comment?: string;
    state?: "open" | "closed";
}) {
    if (github.context.eventName !== "issues") return;

    const issue = github.context.payload.issue;
    if (!issue) return;

    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) {
        core.warning("No GITHUB_TOKEN available; cannot comment/close issue.");
        return;
    }

    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;
    const issue_number = issue.number;

    if (params.comment) {
        await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number,
            body: params.comment,
        });
    }

    if (params.state) {
        await octokit.rest.issues.update({
            owner,
            repo,
            issue_number,
            state: params.state,
        });
    }
}

async function run() {
    try {
        const token = req("token");
        const githubId = req("github_id");
        const hmacSecret = opt("hmac_secret", "");
        const apiBase = opt("api_base_url", "");
        const cliVersion = opt("cli_version", "");
        const wd = opt("working_directory", ".");
        const extraArgs = opt("extra_args", "");
        const extra = extraArgs ? stringArgv(extraArgs) : [];
        
        // Default inputs
        let buildPath = opt("build_path", "");
        let releaseId = opt("release_id", "");
        let eventType = opt("event_type", "");

        // Handle Issue event
        if (github.context.eventName === "issues") {
            const issue = github.context.payload.issue;
            if (!issue) throw new Error("No issue found in context.");

            core.info(`Issues action: ${(github.context.payload as any).action}`);
            core.info(`Issue by: ${issue.user?.login} (${issue.user?.type})`);

            // Enforce bot login (stronger than type === "Bot")
            const botLogin = "codequill-authorship[bot]";
            const login = String(issue.user?.login || "");
            if (login !== botLogin) {
                core.info(`Skipping issue: not created by expected bot (${login}).`);
                return;
            }

            // Use the label from the event payload (reliable for issues.labeled)
            const evLabel = (github.context.payload as any).label?.name;
            core.info(`Issue label event: ${evLabel}`);

            if (evLabel !== "codequill:release") {
                core.info(`Skipping issue: label event is not codequill:release (${evLabel}).`);
                return;
            }

            // Parse body
            const body = (issue.body || "").trim();
            if (!body) throw new Error("Issue body is empty.");

            try {
                const data = JSON.parse(body);
                let payloadObj = data;

                // Verify HMAC if secret is provided
                if (hmacSecret) {
                    if (!data.signature) throw new Error("Issue payload is missing signature.");
                    if (!data.payload) throw new Error("Issue payload is missing 'payload' field.");
                    
                    const payloadStr = typeof data.payload === "string" ? data.payload : JSON.stringify(data.payload);
                    const hmac = crypto.createHmac("sha256", hmacSecret);
                    hmac.update(payloadStr);
                    const expected = hmac.digest("hex");
                    
                    if (expected !== data.signature) {
                        throw new Error("HMAC signature verification failed.");
                    }
                    
                    payloadObj = typeof data.payload === "string" ? JSON.parse(data.payload) : data.payload;
                } else {
                    core.warning("hmac_secret not provided. Skipping signature verification.");
                    if (data.payload) payloadObj = typeof data.payload === "string" ? JSON.parse(data.payload) : data.payload;
                }

                eventType = payloadObj.event || eventType;
                releaseId = payloadObj.release_id || releaseId;
            } catch (e: any) {
                throw new Error(`Failed to parse issue body as JSON or verify signature: ${e.message}`);
            }
        }
        
        // Fallback for event type detection
        if (!eventType) {
            eventType = opt("event_type", github.context.payload?.action || github.context.eventName);
        }

        // Set outputs
        core.setOutput("event_type", eventType);
        core.setOutput("release_id", releaseId);

        const wdAbs = path.resolve(process.cwd(), wd);
        ensureDir(wdAbs);
        process.chdir(wdAbs);

        core.info(`Processing event: ${eventType}`);

        if (eventType === "release_anchored") {
            core.info("Release anchored event received. No attestation required at this stage.");
            core.info("User can proceed with build and deployment.");
            return;
        }

        if (eventType === "release_approved" || !eventType || (github.context.eventName !== "repository_dispatch" && github.context.eventName !== "issues")) {
            // If it's release_approved or if we are not in a dispatch/issue event (e.g. manual run)
            // We should have buildPath and releaseId
            
            if (!buildPath || !releaseId) {
                if (eventType === "release_approved") {
                    throw new Error("release_approved event requires both build_path and release_id inputs.");
                } else {
                    core.warning("build_path or release_id not provided. Skipping attestation.");
                    return;
                }
            }

            await installCli(cliVersion);

            const env: Record<string,string> = {
                CODEQUILL_TOKEN: token,
                CODEQUILL_GITHUB_ID: githubId
            };
            if (apiBase) env.CODEQUILL_API_BASE_URL = apiBase;

            core.info(`Attesting build: ${buildPath} for release: ${releaseId}`);
            
            // Following the pattern of using non-interactive flags if possible
            const args = ["attest", buildPath, releaseId, "--no-confirm", "--json", "--no-wait", ...extra];
            const output = await runCli(args, env);
            
            let txHash = "";
            try {
                const res = JSON.parse(output.stdout);
                txHash = res.tx_hash;
                if (res.explorer_url) {
                    core.info(`View transaction on explorer: ${res.explorer_url}`);
                }
            } catch (e) {
                core.warning("Failed to parse output as JSON. Transaction hash not found.");
            }

            if (txHash) {
                core.info(`Waiting for attestation transaction: ${txHash}`);
                await runCli(["wait", txHash, ...extra], env);
            } else {
                core.warning("No transaction hash found, skipping wait.");
            }
        } else {
            core.info(`Event type ${eventType} is not handled by this action.`);
        }

        await closeIssueWithComment({
            comment: "✅ CodeQuill job processed.",
            state: "closed",
        });
        core.info("Done.");
    } catch (e: any) {
        const msg = e?.message ? String(e.message) : String(e);
        core.setFailed(msg);
        try {
            await closeIssueWithComment({ comment: `❌ CodeQuill job failed: ${msg}` });
        } catch (err: any) {
            core.warning(`Unable to comment on issue: ${err?.message ?? String(err)}`);
        }
    }
}

run();
