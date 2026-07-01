import { Meteor } from "meteor/meteor";
import "./main.css";

async function loadDeeplinks() {
  const data = await fetch("/deeplinks").then((r) => r.json());

  document.getElementById("serverUrl").textContent = window.location.origin;
  document.getElementById("uploadArtifactId").textContent = data.artifactId;
  document.getElementById("deeplinkUpload").textContent = data.upload;
  document.getElementById("openBtnUpload").href = data.upload;
  document.getElementById("qrUpload").src = data.qrUpload;

  const badge = document.getElementById("authBadge");
  badge.textContent = data.authMode ? "auth: on" : "auth: off";
  badge.classList.toggle("on", data.authMode);
  document.getElementById("authHelp").hidden = !data.authMode;
}

function formatSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

async function loadVideos() {
  const list = document.getElementById("videoList");
  const videos = await fetch("/videos").then((r) => r.json());
  if (!videos.length) {
    list.innerHTML = '<p class="mono">No uploads yet.</p>';
    return;
  }
  list.innerHTML = videos.map((v) => `
    <div style="margin-bottom: 1rem; padding-bottom: 1rem; border-bottom: 1px solid #30363d;">
      <video src="/pulsevault/artifacts/${v.artifactId}" controls preload="metadata" style="width: 100%; max-height: 26rem; border-radius: 6px; background: #000; display: block; object-fit: contain;"></video>
      <p class="mono" style="margin: 0.4rem 0 0;">${v.filename}</p>
      <p class="mono" style="margin: 0.15rem 0 0; color: #6e7681;">${formatSize(v.size)} • ${new Date(v.creation_date).toLocaleString()}</p>
      <p class="mono" style="margin: 0.15rem 0 0; color: #6e7681;">${v.artifactId}</p>
    </div>
  `).join("");
}

Meteor.startup(() => {
  loadDeeplinks();
  loadVideos();
  document.getElementById("refreshUpload").addEventListener("click", loadDeeplinks);
  document.getElementById("refreshVideos").addEventListener("click", loadVideos);
});
