import { expect, test } from "vitest";
import { classifyQuestion, deployIntent, triageQuestion } from "./logic";

const ROUTINE = [
  "Should I refactor the parser? No DNS change is involved.",
  "Can I proceed with the UI fix? I won't touch DNS.",
  "Don't spend anything on this; should I use the free tier?",
  "Should I update the README without touching certs?",
  "No DNS change needed. Should I rename the component?",
  "Can I dig the DNS records to confirm the A record points to the VPS?",
  "Should I check the DNS propagation for api.example.com?",
  "When does the TLS certificate expire?",
  "Should I inspect the cert chain served by nginx?",
  "Should I generate a self-signed cert for localhost?",
  "Should I create a debug keystore for local builds?",
  "How much would it cost to buy the domain?",
  "Can you estimate the monthly cost of the bigger VPS?",
  "Should I spend more time on the tests?",
  "Should I test the purchase flow with a sandbox account?",
  "Should the billing page show the invoice history?",
  "Should paying users see the badge?",
  "Should I check the prod logs for the crash?",
  "Should I send a test notification to the emulator?",
  "Is DNS configured correctly for the staging host?",
  "Should I add push notifications via FCM?",
  "Should the release build use R8?",
  "Should I use a whether or not flag in the parser?",
];

const IRREVERSIBLE = [
  "Should I update the DNS A record to the new VPS?",
  "Can I add a TXT record for domain verification?",
  "Should I change the nameservers to Cloudflare?",
  "Should I revoke the production certificate?",
  "Can I issue a new cert for api.example.com with certbot?",
  "Should I renew the Let's Encrypt cert on the VPS?",
  "Should I generate a new release keystore?",
  "Should I delete the old user records?",
  "Can I drop the users table?",
  "Should I force-push the rebased branch?",
  "Can I git push --force origin main?",
  "Should I buy the $12 domain?",
  "Can I upgrade the Supabase plan to pro?",
  "Should I pay for the Apple developer account?",
  "How much does it cost, and should I buy it?",
  "Should I send an email to all users about the outage?",
  "Should I tweet the launch?",
  "Should I change the production env vars to enable the flag?",
  "Should I rotate the API key?",
  "Should I do something with DNS?", // ambiguous: escalate
];

test("triage: negated or read-only mentions are routine", () => {
  for (const question of ROUTINE) expect([question, classifyQuestion(question, false)]).toEqual([question, "routine"]);
});

test("triage: real irreversible asks escalate", () => {
  for (const question of IRREVERSIBLE) {
    expect([question, classifyQuestion(question, false)]).toEqual([question, "irreversible"]);
  }
});

test("triage: a negation elsewhere does not cover a real irreversible ask", () => {
  const cases: Array<[string, string]> = [
    ["No DNS change needed; should I drop the users table?", "data loss"],
    ["Don't touch DNS. Should I revoke the production cert?", "certificate/signing change"],
    ["We won't change DNS, but I need to buy the domain. OK?", "spending money"],
    ["Without touching certs, should I update the DNS records?", "DNS change"],
    ["Don't spend money on ads, but can I send a newsletter to subscribers?", "external message"],
    ["I won't deploy. Should I force-push main?", "force-push / history rewrite"],
    ["Check the DNS records but then change the MX record?", "DNS change"],
    ["Don't forget to delete the backups?", "data loss"],
    ["Do not hesitate to delete the old accounts?", "data loss"],
    ["I'm not sure whether to delete the table?", "data loss"],
  ];
  for (const [question, reason] of cases) {
    expect([question, triageQuestion(question, false)]).toEqual([question, { class: "irreversible", reason }]);
  }
});

test("triage: genuinely ambiguous DNS/cert/money questions escalate", () => {
  expect(classifyQuestion("Should I do something with DNS?", false)).toBe("irreversible");
  expect(classifyQuestion("Should I sort out the certificates?", false)).toBe("irreversible");
  expect(classifyQuestion("Should I handle the billing?", false)).toBe("irreversible");
  expect(classifyQuestion("Should the DNS be changed?", false)).toBe("irreversible");
});

test("triage: deploy questions follow the deploy rules, negation-aware", () => {
  expect(classifyQuestion("Should I push to origin now?", false)).toBe("irreversible");
  expect(classifyQuestion("Should I push to origin now?", true)).toBe("deploy-allowed");
  expect(classifyQuestion("Can I deploy to prod?", false)).toBe("irreversible");
  expect(classifyQuestion("I won't deploy; should I rename the module?", false)).toBe("routine");
  expect(classifyQuestion("Should I merge to local main without pushing?", false)).toBe("routine");
  // A requested deploy never unlocks prod config changes, force-push or DNS.
  expect(classifyQuestion("Deploy done; should I change the production config flag?", true)).toBe("irreversible");
  expect(classifyQuestion("Should I force-push to prod?", true)).toBe("irreversible");
  expect(classifyQuestion("Should I deploy and update the DNS record?", true)).toBe("irreversible");
  // The same negation cues drive the task-level deploy intent.
  expect(deployIntent("Don't deploy; fix the parser").requested).toBe(false);
  expect(classifyQuestion("Don't deploy; fix the parser?", true)).toBe("routine");
});

test("triage: the worker's own irreversible flag still escalates", () => {
  expect(classifyQuestion("Should I rename the table column?", false, "irreversible")).toBe("irreversible");
  expect(triageQuestion("Rename the helper?", false).reason).toBe("no irreversible action");
});
