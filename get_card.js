// get_card.js <id>
require("dotenv").config();
const axios = require("axios");
const { AZURE_DEVOPS_ORG, AZURE_DEVOPS_PROJECT, AZURE_DEVOPS_PAT } = process.env;
const BASE = `https://dev.azure.com/${AZURE_DEVOPS_ORG}/${AZURE_DEVOPS_PROJECT}/_apis`;
const auth = `Basic ${Buffer.from(":" + AZURE_DEVOPS_PAT).toString("base64")}`;
const ax = axios.create({ headers: { Authorization: auth } });

(async () => {
  const id = process.argv[2];
  const r = await ax.get(
    `${BASE}/wit/workitems/${id}?fields=System.Id,System.Title,System.WorkItemType,System.State,System.Parent,System.AreaPath,System.IterationPath,System.Description,Microsoft.VSTS.Common.AcceptanceCriteria,Microsoft.VSTS.Scheduling.Effort&api-version=7.0`,
  );
  const f = r.data.fields;
  console.log("ID:", f["System.Id"]);
  console.log("Type:", f["System.WorkItemType"]);
  console.log("State:", f["System.State"]);
  console.log("Title:", f["System.Title"]);
  console.log("Parent:", f["System.Parent"]);
  console.log("Area:", f["System.AreaPath"], "| Iteration:", f["System.IterationPath"]);
  console.log("Effort:", f["Microsoft.VSTS.Scheduling.Effort"]);
  console.log("\n--- DESCRIPTION ---\n" + (f["System.Description"] || "(vazio)"));
  console.log("\n--- ACCEPTANCE CRITERIA ---\n" + (f["Microsoft.VSTS.Common.AcceptanceCriteria"] || "(vazio)"));
})().catch((e) => console.error("ERR", e.response?.status, e.response?.data?.message || e.message));
