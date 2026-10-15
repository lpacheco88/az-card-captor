// verify_sync.js
require("dotenv").config();
const axios = require("axios");
const { AZURE_DEVOPS_ORG, AZURE_DEVOPS_PROJECT, AZURE_DEVOPS_PAT } = process.env;
const BASE = `https://dev.azure.com/${AZURE_DEVOPS_ORG}/${AZURE_DEVOPS_PROJECT}/_apis`;
const auth = `Basic ${Buffer.from(":" + AZURE_DEVOPS_PAT).toString("base64")}`;
const ax = axios.create({ headers: { Authorization: auth } });

const ids = [107176,107247,107277,107281,107282,107283,107284,107285,110039,110044,110045,110682,110686,110690,110694,110698,110702,110706,110710];

(async () => {
  const r = await ax.get(
    `${BASE}/wit/workitems?ids=${ids.join(",")}&fields=System.Id,System.State,Microsoft.VSTS.Scheduling.CompletedWork,Microsoft.VSTS.Scheduling.Effort&api-version=7.0`,
  );
  console.log("ID       | State        | CompletedWork | Effort");
  for (const it of r.data.value) {
    const f = it.fields;
    console.log(
      String(f["System.Id"]).padEnd(8),
      "|",
      String(f["System.State"] || "-").padEnd(12),
      "|",
      String(f["Microsoft.VSTS.Scheduling.CompletedWork"] ?? "-").padEnd(13),
      "|",
      String(f["Microsoft.VSTS.Scheduling.Effort"] ?? "-"),
    );
  }
})().catch((e) => console.error("ERR", e.response?.status, e.response?.data?.message || e.message));
