// probe_states.js — descobre WorkItemType e estados válidos (não imprime segredo)
require("dotenv").config();
const axios = require("axios");
const { AZURE_DEVOPS_ORG, AZURE_DEVOPS_PROJECT, AZURE_DEVOPS_PAT } = process.env;
const BASE = `https://dev.azure.com/${AZURE_DEVOPS_ORG}/${AZURE_DEVOPS_PROJECT}/_apis`;
const auth = `Basic ${Buffer.from(":" + AZURE_DEVOPS_PAT).toString("base64")}`;
const ax = axios.create({ headers: { Authorization: auth } });

(async () => {
  const ids = [107176, 110686, 110710, 110698];
  const r = await ax.get(
    `${BASE}/wit/workitems?ids=${ids.join(",")}&fields=System.Id,System.WorkItemType,System.State,System.Title&api-version=7.0`,
  );
  for (const it of r.data.value) {
    console.log(it.id, "|", it.fields["System.WorkItemType"], "|", it.fields["System.State"], "|", it.fields["System.Title"]);
  }
  const types = [...new Set(r.data.value.map((i) => i.fields["System.WorkItemType"]))];
  for (const t of types) {
    try {
      const s = await ax.get(`${BASE}/wit/workitemtypes/${encodeURIComponent(t)}/states?api-version=7.0`);
      console.log("STATES", t, "=>", s.data.value.map((x) => `${x.name}[${x.category}]`).join(", "));
    } catch (e) {
      console.log("STATES", t, "ERR", e.response?.status, e.response?.data?.message || e.message);
    }
  }
})().catch((e) => console.error("ERR", e.response?.status, e.response?.data?.message || e.message));
