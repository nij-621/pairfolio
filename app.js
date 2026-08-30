import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);
const fmtEur = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const todayStr = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD, 로컬 기준

let me = null;            // { email, member_code, display_name }
let cats = [];            // categories
let accounts = [];
let trips = [];
let rules = [];
let listMonth = todayStr().slice(0, 7);   // "YYYY-MM"

// ─────────────────────────────────────────── 공통 UI
function toast(msg, ms = 2200) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), ms);
}
function openModal(html) {
  $("modal").innerHTML =
    `<button class="modal-x" type="button" aria-label="닫기"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>` + html;
  $("modal").querySelector(".modal-x").onclick = closeModal;
  $("modal-wrap").hidden = false;
}
function closeModal() { $("modal-wrap").hidden = true; $("modal").innerHTML = ""; }
// textarea 높이를 내용에 맞춰 자동 조절
function autoGrow(el) {
  if (!el) return () => {};
  const fit = () => { el.style.height = "auto"; el.style.height = el.scrollHeight + 2 + "px"; };
  el.addEventListener("input", fit);
  requestAnimationFrame(fit); // 모달이 첫 프레임에 그려진 뒤 측정해야 정확함
  return fit;
}
$("modal-back")?.addEventListener("click", closeModal);
document.addEventListener("click", (e) => { if (e.target.id === "modal-back") closeModal(); });

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ─────────────────────────────────────────── 인증
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return showAuth();
  await enterApp(session);
}
function showAuth() {
  $("screen-auth").hidden = false; $("app").hidden = true;
}
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn"); btn.disabled = true; $("login-err").hidden = true;
  const { data, error } = await sb.auth.signInWithPassword({
    email: $("login-email").value.trim(), password: $("login-pw").value,
  });
  btn.disabled = false;
  if (error) { $("login-err").textContent = "로그인 실패: " + error.message; $("login-err").hidden = false; return; }
  await enterApp(data.session);
});
$("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });

async function enterApp(session) {
  const email = session.user.email;
  const { data: m, error } = await sb.from("household_members").select("*").eq("email", email).maybeSingle();
  if (error || !m) {
    await sb.auth.signOut();
    $("login-err").textContent = "이 계정은 가족 구성원으로 등록되어 있지 않습니다.";
    $("login-err").hidden = false;
    return showAuth();
  }
  me = m;
  $("screen-auth").hidden = true; $("app").hidden = false;
  $("me-chip").textContent = m.display_name;
  $("me-chip").classList.add(m.member_code.toLowerCase());
  await loadRefs();
  await loadCatFreq();
  initAddForm();
  renderList();
  renderRules();
  renderMore();
  flushQueue();
  postRecurring();
}

async function loadRefs() {
  const [c, a, t, r] = await Promise.all([
    sb.from("categories").select("*").order("sort"),
    sb.from("accounts").select("*").order("sort"),
    sb.from("trips").select("*").order("start_date", { ascending: false }),
    sb.from("recurring_rules").select("*").order("name"),
  ]);
  cats = c.data ?? []; accounts = a.data ?? []; trips = t.data ?? []; rules = r.data ?? [];
}

async function postRecurring() {
  const { data, error } = await sb.rpc("post_due_occurrences");
  if (!error && data > 0) { toast(`반복 거래 ${data}건 자동 기록됨`); renderList(); }
}

// ─────────────────────────────────────────── 입력 탭
const addState = { currency: "EUR", catId: null, who: null, showAll: false };

// 최근 3개월, 내(로그인 구성원) 지출 빈도 → 즐겨찾기 카테고리 순서
let catFreq = {};
async function loadCatFreq() {
  const since = new Date(); since.setMonth(since.getMonth() - 3);
  const { data } = await sb.from("transactions").select("category_id")
    .eq("paid_by", me.member_code).eq("tx_type", "expense")
    .is("deleted_at", null).gte("tx_date", since.toLocaleDateString("sv-SE"));
  catFreq = {};
  for (const t of data ?? []) catFreq[t.category_id] = (catFreq[t.category_id] ?? 0) + 1;
}

function initAddForm() {
  addState.who = me.member_code;
  $("add-date").value = todayStr();
  renderCatGrid();
  renderWhoSeg();
  updateSaveButton();
  updateTripNote();
  $("add-amount").addEventListener("input", updateSaveButton);
}
function renderCatGrid() {
  const g = $("cat-grid"); g.innerHTML = "";
  const make = (c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = c.name;
    b.className = addState.catId === c.id ? "on" : "";
    b.onclick = () => { addState.catId = c.id; renderCatGrid(); updateSaveButton(); };
    return b;
  };
  const exp = cats.filter((c) => !c.archived && c.kind === "expense")
    .sort((a, b) => (catFreq[b.id] ?? 0) - (catFreq[a.id] ?? 0) || a.sort - b.sort);
  const inc = cats.filter((c) => !c.archived && c.kind === "income");
  const top = exp.slice(0, 8);
  const rest = exp.slice(8);
  const mustExpand = addState.catId && !top.some((c) => c.id === addState.catId);
  const showAll = addState.showAll || mustExpand;

  top.forEach((c) => g.appendChild(make(c)));
  if (!showAll) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "more-btn";
    b.textContent = `전체 보기 (${rest.length + inc.length}) ▾`;
    b.onclick = () => { addState.showAll = true; renderCatGrid(); };
    g.appendChild(b);
  } else {
    rest.forEach((c) => g.appendChild(make(c)));
    const sep = document.createElement("p");
    sep.className = "cat-sep"; sep.textContent = "수입";
    g.appendChild(sep);
    inc.forEach((c) => g.appendChild(make(c)));
    const edit = document.createElement("button");
    edit.type = "button"; edit.className = "more-btn"; edit.textContent = "카테고리 편집";
    edit.onclick = openCatManager;
    g.appendChild(edit);
    const b = document.createElement("button");
    b.type = "button"; b.className = "more-btn"; b.textContent = "접기 ▴";
    b.onclick = () => { addState.showAll = false; if (mustExpand) addState.catId = null; renderCatGrid(); updateSaveButton(); };
    g.appendChild(b);
  }
}

// ── 카테고리 관리 (삭제 = 보관: 기존 내역은 유지, 그리드에서만 사라짐) ──
function openCatManager() {
  openModal(`
    <h3>카테고리 편집</h3>
    <div class="row-2">
      <label style="flex:2">새 카테고리<input id="cm-name" placeholder="이름"></label>
      <label>종류<select id="cm-kind"><option value="expense">지출</option><option value="income">수입</option></select></label>
    </div>
    <button class="btn-primary" id="cm-add" style="margin-top:12px">추가</button>
    <label style="margin-top:18px">사용 중</label>
    <div id="cm-active" class="sheet"></div>
    <label style="margin-top:14px">보관됨</label>
    <div id="cm-archived" class="sheet"></div>`);
  const renderLists = () => {
    const act = $("cm-active"); act.innerHTML = "";
    for (const c of cats.filter((x) => !x.archived)) {
      const r = document.createElement("div");
      r.className = "lrow";
      r.innerHTML = `<span class="cat">${esc(c.name)}</span><span class="memo">${c.kind === "income" ? "수입" : "지출"}</span>`;
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "btn-ghost danger"; btn.textContent = "보관";
      btn.onclick = async () => {
        const { error } = await sb.from("categories").update({ archived: true }).eq("id", c.id);
        if (error) return toast("실패: " + error.message);
        if (addState.catId === c.id) addState.catId = null;
        await loadRefs(); renderLists(); renderCatGrid(); toast(`"${c.name}" 보관됨`);
      };
      r.appendChild(btn); act.appendChild(r);
    }
    const ar = $("cm-archived");
    const archived = cats.filter((x) => x.archived);
    ar.innerHTML = archived.length ? "" : `<p class="empty">없음</p>`;
    for (const c of archived) {
      const r = document.createElement("div");
      r.className = "lrow";
      r.innerHTML = `<span class="cat">${esc(c.name)}</span><span class="memo">${c.kind === "income" ? "수입" : "지출"}</span>`;
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "btn-ghost"; btn.textContent = "복원";
      btn.onclick = async () => {
        const { error } = await sb.from("categories").update({ archived: false }).eq("id", c.id);
        if (error) return toast("실패: " + error.message);
        await loadRefs(); renderLists(); renderCatGrid(); toast(`"${c.name}" 복원됨`);
      };
      r.appendChild(btn); ar.appendChild(r);
    }
  };
  $("cm-add").onclick = async () => {
    const name = $("cm-name").value.trim();
    if (!name) return toast("이름을 입력하세요");
    const { error } = await sb.from("categories").insert({ name, kind: $("cm-kind").value, sort: 50 });
    if (error) return toast(/duplicate/.test(error.message) ? "같은 이름이 이미 있어요" : "추가 실패");
    $("cm-name").value = "";
    await loadRefs(); renderLists(); renderCatGrid(); toast(`"${name}" 추가됨`);
  };
  renderLists();
}
const WHO_NAME = { KM: "규문", MK: "민경" };
function renderWhoSeg() {
  const s = $("add-who"); s.innerHTML = "";
  for (const code of ["KM", "MK"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `<span class="nib"></span>${WHO_NAME[code]}`;
    b.className = (addState.who === code ? "on " : "") + code.toLowerCase();
    b.onclick = () => { addState.who = code; renderWhoSeg(); updateSaveButton(); };
    s.appendChild(b);
  }
}
// 결제자 색 반응 (저장 버튼이 그 사람의 펜 색이 된다)
function updateSaveButton() {
  const btn = $("add-save");
  btn.classList.remove("km", "mk");
  btn.classList.add(addState.who.toLowerCase());
  const sub = $("add-save-sub");
  const cat = cats.find((c) => c.id === addState.catId);
  const raw = parseFloat($("add-amount").value.replace(/,/g, "."));
  const parts = [WHO_NAME[addState.who]];
  if (cat) parts.push(cat.name);
  if (raw > 0) parts.push(raw.toLocaleString("en-US", { minimumFractionDigits: 2 }) + (addState.currency === "KRW" ? " ₩" : " €"));
  sub.textContent = parts.join(" · ");
  sub.hidden = parts.length < 2;
}
$("add-currency").addEventListener("click", () => {
  addState.currency = addState.currency === "EUR" ? "KRW" : "EUR";
  const b = $("add-currency");
  b.textContent = addState.currency;
  b.classList.toggle("krw", addState.currency === "KRW");
  $("add-fx-note").hidden = addState.currency !== "KRW";
  if (addState.currency === "KRW") $("add-fx-note").textContent = "원화 입력 — 저장 시 ECB 환율로 자동 환산";
  updateSaveButton();
});
$("add-date").addEventListener("change", updateTripNote);

function currentTrip(dateStr) {
  return trips.find((t) => t.start_date <= dateStr && dateStr <= t.end_date) ?? null;
}
function updateTripNote() {
  const t = currentTrip($("add-date").value);
  $("add-trip-note").hidden = !t;
  if (t) $("add-trip-note").textContent = `여행 "${t.name}"에 자동 태깅됩니다`;
}

async function fxRate(dateStr) {
  // ECB 기준환율 (Frankfurter, ECB 단일 소스). 주말·미래일이면 가장 최근 영업일 값이 온다.
  const d = dateStr > todayStr() ? todayStr() : dateStr;
  const res = await fetch(`https://api.frankfurter.dev/v1/${d}?base=EUR&symbols=KRW`);
  if (!res.ok) throw new Error("환율 조회 실패");
  const j = await res.json();
  return { rate: j.rates.KRW, rateDate: j.date };
}

$("add-save").addEventListener("click", async () => {
  const raw = $("add-amount").value.replace(/,/g, ".").replace(/[^\d.]/g, "");
  const amount = parseFloat(raw);
  const msgEl = $("add-msg");
  msgEl.hidden = true; msgEl.classList.remove("bad");
  if (!amount || amount <= 0) return showAddMsg("금액을 입력하세요", true);
  if (!addState.catId) return showAddMsg("카테고리를 선택하세요", true);

  const cat = cats.find((c) => c.id === addState.catId);
  const dateStr = $("add-date").value || todayStr();
  const trip = currentTrip(dateStr);
  const tx = {
    id: crypto.randomUUID(),
    tx_date: dateStr,
    tx_type: cat.kind === "income" ? "income" : "expense",
    category_id: addState.catId,
    trip_id: trip?.id ?? null,
    paid_by: addState.who,
    memo: $("add-memo").value.trim(),
    source: "app",
    orig_currency: addState.currency,
  };
  const btn = $("add-save"); btn.disabled = true;
  try {
    if (addState.currency === "KRW") {
      const { rate, rateDate } = await fxRate(dateStr);
      tx.orig_amount = amount;
      tx.fx_rate = rate; tx.fx_rate_date = rateDate; tx.fx_provider = "ECB";
      tx.amount_eur = Math.round((amount / rate) * 100) / 100;
    } else {
      tx.amount_eur = Math.round(amount * 100) / 100;
    }
    await insertTx(tx);
    resetAddForm();
    showAddMsg(`저장됨 · ${cat.name} ${fmtEur(tx.amount_eur)}`);
  } catch (err) {
    if (tx.amount_eur == null) {
      showAddMsg("환율 조회에 실패했어요. 네트워크를 확인하거나 EUR로 입력하세요.", true);
    } else {
      queueTx(tx);
      resetAddForm();
      showAddMsg("오프라인 — 기기에 보관했고, 연결되면 재전송됩니다", true);
    }
  } finally { btn.disabled = false; }
});
function showAddMsg(text, bad = false) {
  const m = $("add-msg");
  m.textContent = text; m.hidden = false; m.classList.toggle("bad", bad);
  clearTimeout(m._h); m._h = setTimeout(() => (m.hidden = true), 3200);
}
function resetAddForm() {
  $("add-amount").value = ""; $("add-memo").value = "";
  addState.catId = null; addState.showAll = false;
  renderCatGrid(); updateSaveButton();
  $("add-amount").focus();
}
async function insertTx(tx) {
  const { error } = await sb.from("transactions").insert(tx);
  if (error && !/duplicate key/.test(error.message)) throw error;
  renderList();
}

// ── 실패 큐 (온라인 전용 + 로컬 보관 재전송) ──
function queueTx(tx) {
  try {
    const q = JSON.parse(localStorage.getItem("pf_queue") ?? "[]");
    q.push(tx); localStorage.setItem("pf_queue", JSON.stringify(q));
  } catch {}
  updateBanner();
}
function updateBanner() {
  let q = [];
  try { q = JSON.parse(localStorage.getItem("pf_queue") ?? "[]"); } catch {}
  $("banner").hidden = q.length === 0;
  if (q.length) $("banner-text").textContent = `전송 대기 ${q.length}건`;
}
async function flushQueue() {
  let q = [];
  try { q = JSON.parse(localStorage.getItem("pf_queue") ?? "[]"); } catch {}
  if (!q.length) return updateBanner();
  const remain = [];
  for (const tx of q) {
    try { await insertTx(tx); } catch { remain.push(tx); }
  }
  try { localStorage.setItem("pf_queue", JSON.stringify(remain)); } catch {}
  updateBanner();
  if (q.length && !remain.length) toast("대기분 전송 완료");
}
$("banner-retry").addEventListener("click", flushQueue);
window.addEventListener("online", flushQueue);

// ─────────────────────────────────────────── 내역 탭
const MIN_YM = "2018-10";
$("mo-prev").addEventListener("click", () => { clearSearch(); shiftMonth(-1); });
$("mo-next").addEventListener("click", () => { clearSearch(); shiftMonth(1); });
$("mo-today").addEventListener("click", () => { clearSearch(); listMonth = todayStr().slice(0, 7); renderList(); });
$("mo-label").addEventListener("click", () =>
  openMonthPicker(listMonth, (ym) => { clearSearch(); listMonth = ym; renderList(); }));

function openMonthPicker(current, onPick) {
  openModal(`<h3>달 선택</h3><div class="pk-years" id="pk-years"></div><div class="pk-mos" id="pk-mos"></div>`);
  const nowYm = todayStr().slice(0, 7);
  let selY = Number(current.slice(0, 4));
  const renderMos = () => {
    const w = $("pk-mos"); w.innerHTML = "";
    for (let m = 1; m <= 12; m++) {
      const ym = `${selY}-${String(m).padStart(2, "0")}`;
      const b = document.createElement("button");
      b.type = "button"; b.textContent = m + "월";
      b.disabled = ym < MIN_YM || ym > nowYm;
      b.className = ym === current ? "on" : "";
      b.onclick = () => { closeModal(); onPick(ym); };
      w.appendChild(b);
    }
  };
  const renderYears = () => {
    const w = $("pk-years"); w.innerHTML = "";
    for (let y = 2018; y <= Number(nowYm.slice(0, 4)); y++) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = y;
      b.className = y === selY ? "on" : "";
      b.onclick = () => { selY = y; renderYears(); renderMos(); };
      w.appendChild(b);
      if (y === selY) requestAnimationFrame(() => b.scrollIntoView({ inline: "center", block: "nearest" }));
    }
  };
  renderYears(); renderMos();
}
function shiftMonth(d) {
  const [y, m] = listMonth.split("-").map(Number);
  const nd = new Date(y, m - 1 + d, 1);
  listMonth = nd.toLocaleDateString("sv-SE").slice(0, 7);
  renderList();
}
function monthRange(ym) {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, "0")}`];
}

const fmtNum = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── 검색 (전체 기간: 메모·카테고리명·정확 금액) ──
let searchTimer;
$("tx-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { $("tx-search").value.trim() ? runSearch() : renderList(); }, 280);
});
function clearSearch() { if ($("tx-search").value) $("tx-search").value = ""; }

async function runSearch() {
  const q = $("tx-search").value.trim();
  if (!q) return renderList();
  const safe = q.replace(/[,()]/g, " ").trim();
  const ors = [`memo.ilike.%${safe}%`];
  const catIds = cats.filter((c) => c.name.includes(q)).map((c) => c.id);
  if (catIds.length) ors.push(`category_id.in.(${catIds.join(",")})`);
  if (/^[\d.,]+$/.test(q)) {
    const n = parseFloat(q.replace(",", "."));
    if (!isNaN(n)) ors.push(`amount_eur.eq.${n}`);
  }
  const LIMIT = 150;
  const { data, error } = await sb.from("transactions")
    .select("*").is("deleted_at", null)
    .or(ors.join(","))
    .order("tx_date", { ascending: false }).limit(LIMIT);
  if (error) { $("tx-list").innerHTML = `<p class="empty">검색 실패</p>`; return; }

  $("mo-label").innerHTML = `검색 결과`;
  const list = $("tx-list"); list.innerHTML = "";
  if (!data.length) {
    $("mo-summary").innerHTML = "";
    list.innerHTML = `<p class="empty">"${esc(q)}" 결과 없음</p>`;
    return;
  }
  const spendSum = data.filter((t) => t.tx_type === "expense")
    .reduce((s, t) => s + Number(t.amount_eur), 0);
  $("mo-summary").innerHTML =
    `<p class="search-sum">${data.length}건${data.length === LIMIT ? "+" : ""} · 지출 합계 ${fmtNum(spendSum)} €${data.length === LIMIT ? " (최근 " + LIMIT + "건만 표시)" : ""}</p>`;

  let curYm = "";
  let sheet = null;
  for (const t of data) {
    const ym = t.tx_date.slice(0, 7);
    if (ym !== curYm) {
      curYm = ym;
      const h = document.createElement("p");
      h.className = "search-head";
      h.textContent = `${ym.slice(0, 4)}년 ${Number(ym.slice(5, 7))}월`;
      list.appendChild(h);
      sheet = document.createElement("div");
      sheet.className = "sheet";
      list.appendChild(sheet);
    }
    sheet.appendChild(txRow(t));
  }
}

async function renderList() {
  if ($("tx-search").value.trim()) return runSearch();
  const [ly, lm] = listMonth.split("-");
  $("mo-label").innerHTML = `${ly}년 ${Number(lm)}월 <span class="car">▾</span>`;
  $("mo-today").hidden = listMonth === todayStr().slice(0, 7);
  const [from, to] = monthRange(listMonth);
  const { data, error } = await sb.from("transactions")
    .select("*").is("deleted_at", null)
    .gte("tx_date", from).lte("tx_date", to)
    .order("tx_date", { ascending: false }).order("created_at", { ascending: false });
  if (error) { $("tx-list").innerHTML = `<p class="empty">불러오기 실패</p>`; return; }

  let spend = 0, income = 0, spendKm = 0, spendMk = 0;
  for (const t of data) {
    if (t.tx_type === "expense") {
      spend += Number(t.amount_eur);
      if (t.paid_by === "KM") spendKm += Number(t.amount_eur); else spendMk += Number(t.amount_eur);
    }
    if (t.tx_type === "income") income += Number(t.amount_eur);
  }
  $("mo-summary").innerHTML =
    `<div class="mo-totals"><span>지출 <b>${fmtEur(spend)}</b></span><span>수입 <b>${fmtEur(income)}</b></span></div>`;

  const list = $("tx-list"); list.innerHTML = "";
  if (!data.length) { list.innerHTML = `<p class="empty">이 달 기록이 없습니다</p>`; return; }
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  let curDay = "";
  for (const t of data) {
    const firstOfDay = t.tx_date !== curDay;
    curDay = t.tx_date;
    sheet.appendChild(txRow(t, false, firstOfDay));
  }
  list.appendChild(sheet);
  if (spend > 0) {
    const tl = document.createElement("div");
    tl.className = "tot-line";
    tl.innerHTML = `<span class="k">규문 ${fmtNum(spendKm)}</span><span>${Number(lm)}월 지출 ${fmtNum(spend)}</span><span class="m">민경 ${fmtNum(spendMk)}</span>`;
    list.appendChild(tl);
  }
}
function catName(id) { return cats.find((c) => c.id === id)?.name ?? "—"; }
function txRow(t, inTrash = false, showDay = true) {
  const b = document.createElement("button");
  b.className = "lrow " + t.paid_by.toLowerCase(); b.type = "button";
  const income = t.tx_type === "income";
  b.innerHTML =
    `<span class="d">${showDay ? Number(t.tx_date.slice(8, 10)) : ""}</span>` +
    `<span class="cat">${esc(catName(t.category_id))}</span>` +
    `<span class="memo">${esc(t.memo)}</span>` +
    `<span class="amt ${income ? "income" : ""}">${fmtNum(t.amount_eur)}</span>`;
  b.onclick = () => (inTrash ? openTrashItem(t) : openEditTx(t));
  return b;
}

function openEditTx(t) {
  const catOpts = cats.filter((c) => !c.archived || c.id === t.category_id)
    .map((c) => `<option value="${c.id}" ${c.id === t.category_id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const tripOpts = ['<option value="">여행 없음</option>']
    .concat(trips.map((x) => `<option value="${x.id}" ${x.id === t.trip_id ? "selected" : ""}>${esc(x.name)}</option>`)).join("");
  const rule = t.rule_id ? rules.find((x) => x.id === t.rule_id) : null;
  openModal(`
    <h3>거래 수정</h3>
    <div class="row-2">
      <label>날짜<input type="date" id="e-date" value="${t.tx_date}"></label>
      <label>금액 (EUR)<input type="text" inputmode="decimal" id="e-amt" value="${t.amount_eur}"></label>
    </div>
    <label>카테고리<select id="e-cat">${catOpts}</select></label>
    <label>메모<textarea id="e-memo" rows="1">${esc(t.memo)}</textarea></label>
    <div class="row-2">
      <label>결제<select id="e-who">
        <option value="KM" ${t.paid_by === "KM" ? "selected" : ""}>KM</option>
        <option value="MK" ${t.paid_by === "MK" ? "selected" : ""}>MK</option>
      </select></label>
      <label>여행<select id="e-trip">${tripOpts}</select></label>
    </div>
    ${t.orig_currency === "KRW" ? `<p class="fx-note">원화 ${Number(t.orig_amount).toLocaleString()}₩ · 환율 ${t.fx_rate} (${t.fx_rate_date})</p>` : ""}
    ${rule ? `<button type="button" class="rule-link" id="e-rule"><span>반복 규칙 「${esc(rule.name)}」에서 자동 기록됨</span><span class="car">규칙 열기 ›</span></button>` : ""}
    <div class="actions">
      <button class="btn-ghost danger" id="e-del">휴지통</button>
      <button class="btn-primary" id="e-save">저장</button>
    </div>`);
  if (rule) $("e-rule").onclick = () => openRuleForm(rule);
  autoGrow($("e-memo"));
  $("e-save").onclick = async () => {
    const amt = parseFloat($("e-amt").value.replace(/,/g, "."));
    if (!amt || amt <= 0) return toast("금액을 확인하세요");
    const cat = cats.find((c) => c.id === $("e-cat").value);
    const { error } = await sb.from("transactions").update({
      tx_date: $("e-date").value,
      amount_eur: Math.round(amt * 100) / 100,
      category_id: $("e-cat").value,
      tx_type: cat.kind === "income" ? "income" : t.tx_type === "income" ? "expense" : t.tx_type,
      memo: $("e-memo").value.trim(),
      paid_by: $("e-who").value,
      trip_id: $("e-trip").value || null,
    }).eq("id", t.id);
    if (error) return toast("저장 실패: " + error.message);
    closeModal(); renderList(); toast("수정됨");
  };
  $("e-del").onclick = async () => {
    const { error } = await sb.from("transactions").update({ deleted_at: new Date().toISOString() }).eq("id", t.id);
    if (error) return toast("삭제 실패");
    closeModal(); renderList(); toast("휴지통으로 이동");
  };
}

// ── 휴지통 ──
$("open-trash").addEventListener("click", async () => {
  const { data } = await sb.from("transactions")
    .select("*").not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false }).limit(100);
  openModal(`<h3>휴지통</h3><div id="trash-list" class="sheet"></div>`);
  const wrap = $("trash-list");
  if (!data?.length) { wrap.innerHTML = `<p class="empty">비어 있음</p>`; return; }
  for (const t of data) wrap.appendChild(txRow(t, true));
});
function openTrashItem(t) {
  openModal(`
    <h3>복원할까요?</h3>
    <p class="fx-note">${t.tx_date} · ${esc(catName(t.category_id))} · ${fmtEur(t.amount_eur)}</p>
    <div class="actions">
      <button class="btn-ghost" id="tr-cancel">닫기</button>
      <button class="btn-primary" id="tr-restore">복원</button>
    </div>`);
  $("tr-cancel").onclick = closeModal;
  $("tr-restore").onclick = async () => {
    await sb.from("transactions").update({ deleted_at: null }).eq("id", t.id);
    closeModal(); renderList(); toast("복원됨");
  };
}

// ─────────────────────────────────────────── 분석 탭
let anMonth = todayStr().slice(0, 7);
$("an-prev").addEventListener("click", () => shiftAnMonth(-1));
$("an-next").addEventListener("click", () => shiftAnMonth(1));
$("an-today").addEventListener("click", () => { anMonth = todayStr().slice(0, 7); renderStats(); });
$("an-label").addEventListener("click", () =>
  openMonthPicker(anMonth, (ym) => { anMonth = ym; renderStats(); }));
function shiftAnMonth(d) {
  const [y, m] = anMonth.split("-").map(Number);
  anMonth = new Date(y, m - 1 + d, 1).toLocaleDateString("sv-SE").slice(0, 7);
  renderStats();
}

async function renderStats() {
  const [ly, lm] = anMonth.split("-");
  $("an-label").innerHTML = `${ly}년 ${Number(lm)}월 <span class="car">▾</span>`;
  $("an-today").hidden = anMonth === todayStr().slice(0, 7);
  const [from, to] = monthRange(anMonth);
  // 비교 기간: 직전 3개월
  const pFrom = new Date(Number(ly), Number(lm) - 1 - 3, 1).toLocaleDateString("sv-SE");
  const pTo = new Date(Number(ly), Number(lm) - 1, 0).toLocaleDateString("sv-SE");

  const sel = "tx_type, category_id, paid_by, amount_eur";
  const [cur, prev] = await Promise.all([
    sb.from("transactions").select(sel).is("deleted_at", null).gte("tx_date", from).lte("tx_date", to),
    sb.from("transactions").select(sel).is("deleted_at", null).gte("tx_date", pFrom).lte("tx_date", pTo),
  ]);
  if (cur.error) { $("an-body").innerHTML = `<p class="empty">불러오기 실패</p>`; return; }

  let spend = 0, income = 0, spendKm = 0, spendMk = 0;
  const catSum = {};
  for (const t of cur.data) {
    const a = Number(t.amount_eur);
    if (t.tx_type === "expense") {
      spend += a;
      catSum[t.category_id] = (catSum[t.category_id] ?? 0) + a;
      if (t.paid_by === "KM") spendKm += a; else spendMk += a;
    } else if (t.tx_type === "income") income += a;
  }
  const prevAvg = {};
  let prevSpend = 0;
  for (const t of prev.data ?? []) {
    if (t.tx_type !== "expense") continue;
    prevAvg[t.category_id] = (prevAvg[t.category_id] ?? 0) + Number(t.amount_eur);
    prevSpend += Number(t.amount_eur);
  }
  for (const k in prevAvg) prevAvg[k] /= 3;
  prevSpend /= 3;

  const rate = income > 0 ? Math.round(((income - spend) / income) * 100) : null;
  const rows = Object.entries(catSum).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const maxV = rows.length ? rows[0][1] : 1;

  const deltaTxt = (curV, avgV) => {
    if (!avgV) return `<small class="delta">신규</small>`;
    const p = Math.round(((curV - avgV) / avgV) * 100);
    if (p === 0) return `<small class="delta">평균 수준</small>`;
    return `<small class="delta ${p > 0 ? "up" : "down"}">${p > 0 ? "▴" : "▾"}${Math.abs(p)}%</small>`;
  };

  // 구독·자동이체 월 환산 (지출 규칙만)
  const CAD_DIV = { monthly: 1, bimonthly: 2, semiannual: 6, yearly: 12 };
  const subRules = rules.filter((r) => r.status === "active" && r.tx_type === "expense");
  const subTotal = subRules.reduce((s, r) => s + Number(r.amount_eur) / CAD_DIV[r.cadence], 0);

  const pk = spend > 0 ? Math.round((spendKm / spend) * 100) : 50;
  const totalDelta = deltaTxt(spend, prevSpend);

  $("an-body").innerHTML = `
    <div class="an-tiles">
      <div class="an-tile"><p class="t">지출 €</p><p class="v">${fmtNum(spend)}</p></div>
      <div class="an-tile"><p class="t">수입 €</p><p class="v in">${fmtNum(income)}</p></div>
      <div class="an-tile"><p class="t">저축률</p><p class="v">${rate === null ? "—" : rate + "%"}</p></div>
    </div>
    <p class="an-note">지출은 소비만 — 대출 상환(이전)·투자 이체는 제외. 지출 3개월 평균 대비 ${totalDelta}</p>

    <p class="an-sec">카테고리별 지출 · 직전 3개월 평균 대비</p>
    <div class="cat-bars">
      ${rows.length ? rows.map(([cid, v]) => `
        <button type="button" class="cbar" data-cat="${cid}">
          <span class="n">${esc(catName(cid))}</span>
          <span class="track" style="width:${Math.max(2, Math.round((v / maxV) * 100))}%"></span>
          <span class="val">${fmtNum(v)}${deltaTxt(v, prevAvg[cid])}</span>
        </button>`).join("") : `<p class="empty">이 달 지출이 없습니다</p>`}
    </div>

    <p class="an-sec">누가 결제했나</p>
    <div class="an-split">
      <div class="bar"><i class="k" style="width:${pk}%"></i><i class="m" style="width:${100 - pk}%"></i></div>
      <div class="lbl"><span class="k">규문 ${fmtNum(spendKm)} € (${pk}%)</span><span class="m">민경 ${fmtNum(spendMk)} € (${100 - pk}%)</span></div>
    </div>

    <p class="an-sec">구독·자동이체 (월 환산)</p>
    <div class="an-tiles" style="grid-template-columns: 1fr 1fr">
      <div class="an-tile"><p class="t">월 환산 합계</p><p class="v">${fmtNum(subTotal)} €</p></div>
      <div class="an-tile"><p class="t">활성 규칙</p><p class="v">${subRules.length}건</p></div>
    </div>`;
  $("an-body").querySelectorAll(".cbar[data-cat]").forEach((b) =>
    b.onclick = () => openCatTrend(b.dataset.cat));
}

// ── 카테고리 추이 (팝업 꺾은선) ──
function ymAdd(ym, d) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1 + d, 1).toLocaleDateString("sv-SE").slice(0, 7);
}
async function fetchCatMonthly(catId) {
  const byMonth = {}; let first = null;
  for (let page = 0; ; page++) {   // Supabase 1,000행 제한 대비 페이지 순회
    const { data, error } = await sb.from("transactions")
      .select("tx_date, amount_eur")
      .eq("category_id", catId).is("deleted_at", null)
      .order("tx_date", { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw error;
    for (const t of data) {
      const k = t.tx_date.slice(0, 7);
      byMonth[k] = (byMonth[k] ?? 0) + Number(t.amount_eur);
      first = first ?? k;
    }
    if (data.length < 1000) break;
  }
  return { byMonth, first };
}
const fmtShort = (v) => Math.round(v).toLocaleString("en-US");

async function openCatTrend(catId) {
  openModal(`
    <h3>${esc(catName(catId))} 추이</h3>
    <div class="trend-seg" id="ct-seg">
      <button type="button" data-m="12m" class="on">12개월</button>
      <button type="button" data-m="3y">3년</button>
      <button type="button" data-m="all">전체</button>
      <button type="button" data-m="year">연도별</button>
    </div>
    <p class="ct-label" id="ct-label">&nbsp;</p>
    <div id="ct-chart"><p class="empty">불러오는 중…</p></div>
    <p class="fine" style="margin-top:10px">최대 = 이 기간에서 가장 컸던 달의 금액(그래프 세로축 천장) · 점선 = 기간 전체의 월평균. 연도별 보기는 해 단위 합계이며 연평균 옆에 월 환산을 함께 보여줘요. 점을 누르면 그 달(해) 금액이 위에 표시돼요.</p>`);
  let res;
  try { res = await fetchCatMonthly(catId); }
  catch { if ($("ct-chart")) $("ct-chart").innerHTML = `<p class="empty">불러오기 실패</p>`; return; }
  if (!$("ct-chart")) return; // 로딩 중 모달이 닫힘
  const { byMonth, first } = res;
  if (!first) { $("ct-chart").innerHTML = `<p class="empty">기록이 없습니다</p>`; return; }

  let mode = "12m";
  const draw = () => {
    const cur = todayStr().slice(0, 7);
    let keys, vals, labelOf;
    if (mode === "year") {
      keys = [];
      for (let y = Number(first.slice(0, 4)); y <= Number(cur.slice(0, 4)); y++) keys.push(String(y));
      vals = keys.map((y) => Object.entries(byMonth).reduce((s, [k, v]) => k.startsWith(y) ? s + v : s, 0));
      // 걸친 해(시작·올해)는 실제 데이터가 있는 개월 수로 월 환산
      const monthsOf = (y) => {
        const a = y === first.slice(0, 4) ? Number(first.slice(5)) : 1;
        const b = y === cur.slice(0, 4) ? Number(cur.slice(5)) : 12;
        return b - a + 1;
      };
      labelOf = (i) => `${keys[i]}년 · ${fmtEur(vals[i])} (월 ${fmtEur(vals[i] / monthsOf(keys[i]))})`;
    } else {
      const from = mode === "12m" ? ymAdd(cur, -11) : mode === "3y" ? ymAdd(cur, -35) : first;
      keys = []; let k = from;
      while (k <= cur) { keys.push(k); k = ymAdd(k, 1); }
      vals = keys.map((k2) => byMonth[k2] ?? 0);
      labelOf = (i) => `${keys[i].slice(0, 4)}년 ${Number(keys[i].slice(5))}월 · ${fmtEur(vals[i])}`;
    }
    const W = 340, H = 180, L = 6, R = 6, T = 16, B = 20;
    const n = vals.length;
    const max = Math.max(...vals, 1);
    const avg = vals.reduce((s, v) => s + v, 0) / n;
    const x = (i) => n === 1 ? W / 2 : L + (i * (W - L - R)) / (n - 1);
    const y = (v) => T + (1 - v / max) * (H - T - B);

    const line = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
    const area = `${line} L${x(n - 1).toFixed(1)} ${H - B} L${x(0).toFixed(1)} ${H - B} Z`;
    // x축 라벨: 12개월은 3개월마다, 월 모드는 1월마다(기간 길면 짝수 해만), 연도별은 해마다
    const yearsSpan = Number(cur.slice(0, 4)) - Number((mode === "year" ? keys[0] : keys[0].slice(0, 4)));
    const ticks = keys.map((k2, i) => {
      let txt = null;
      if (mode === "12m") { if (i % 3 === 0) txt = `${Number(k2.slice(5))}월`; }
      else if (mode === "year") { if (yearsSpan <= 8 || Number(k2) % 2 === 0) txt = `'${k2.slice(2)}`; }
      else if (k2.slice(5) === "01" && (yearsSpan <= 6 || Number(k2.slice(0, 4)) % 2 === 0)) txt = `'${k2.slice(2, 4)}`;
      return txt === null ? "" : `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="var(--ink-2)">${txt}</text>`;
    }).join("");
    const step = n === 1 ? W : (W - L - R) / (n - 1);
    const hits = vals.map((v, i) =>
      `<rect data-i="${i}" x="${(x(i) - step / 2).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${H}" fill="transparent"/>`).join("");
    const dots = n <= 40
      ? vals.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.6" fill="var(--ink)"/>`).join("")
      : "";

    // 라벨은 종이색 테두리(halo)로 그래프 선 위에서도 읽히게, 평균선이 위쪽이면 라벨을 선 아래로
    const halo = `paint-order="stroke" stroke="var(--paper)" stroke-width="3.5" stroke-linejoin="round" pointer-events="none"`;
    const avgY = y(avg);
    const avgLabelY = avgY < 34 ? avgY + 13 : avgY - 5;
    let avgLabel = `월평균 ${fmtShort(avg)} €`;
    if (mode === "year") {
      // 월 환산 = 전체 합 ÷ 전체 개월 수 (부분 연도 왜곡 없음)
      const totalMonths = (Number(cur.slice(0, 4)) - Number(first.slice(0, 4))) * 12
        + Number(cur.slice(5)) - Number(first.slice(5)) + 1;
      avgLabel = `연평균 ${fmtShort(avg)} · 월 ${fmtShort(vals.reduce((s, v) => s + v, 0) / totalMonths)} €`;
    }
    $("ct-chart").innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="var(--card-line)"/>
        <path d="${area}" fill="rgba(38,38,32,.07)"/>
        <line x1="${L}" y1="${avgY.toFixed(1)}" x2="${W - R}" y2="${avgY.toFixed(1)}" stroke="var(--ink-2)" stroke-dasharray="4 4" stroke-width="1"/>
        <path d="${line}" fill="none" stroke="var(--ink)" stroke-width="1.8" stroke-linejoin="round"/>
        ${dots}
        <circle id="ct-dot" r="4.2" fill="var(--paper)" stroke="var(--ink)" stroke-width="2" visibility="hidden"/>
        ${hits}
        ${ticks}
        <text x="${L}" y="10" font-size="9" fill="var(--ink-2)" ${halo}>최대 ${fmtShort(max)} €</text>
        <text x="${W - R}" y="${avgLabelY.toFixed(1)}" text-anchor="end" font-size="9" fill="var(--ink-2)" ${halo}>${avgLabel}</text>
      </svg>`;
    const dot = $("ct-dot");
    const select = (i) => {
      dot.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x(i).toFixed(1));
      dot.setAttribute("cy", y(vals[i]).toFixed(1));
      $("ct-label").textContent = labelOf(i);
    };
    $("ct-chart").querySelectorAll("rect[data-i]").forEach((rc) =>
      rc.onclick = () => select(Number(rc.dataset.i)));
    select(n - 1);
  };
  $("ct-seg").querySelectorAll("button").forEach((b) => b.onclick = () => {
    mode = b.dataset.m;
    $("ct-seg").querySelectorAll("button").forEach((s) => s.classList.toggle("on", s === b));
    draw();
  });
  draw();
}

// ─────────────────────────────────────────── 반복 규칙 (더보기)
const CAD_STEP = { monthly: 1, bimonthly: 2, semiannual: 6, yearly: 12 };
const CAD_KO = { monthly: "매월", bimonthly: "격월", semiannual: "반년", yearly: "매년" };
// post_due_occurrences와 같은 규칙으로 다음 전기 예정일·회차 계산
function ruleNextDue(r) {
  if (r.status !== "active") return null;
  const step = CAD_STEP[r.cadence];
  const [sy, sm, sd] = r.start_date.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  let end = null;
  if (r.end_date) { const [ey, em, ed] = r.end_date.split("-").map(Number); end = new Date(ey, em - 1, ed); }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let y = sy, m = sm - 1, n = 0;
  for (let i = 0; i < 400; i++) {
    const lastDay = new Date(y, m + 1, 0).getDate();
    const due = new Date(y, m, Math.min(r.day_of_month, lastDay));
    n++;
    if (due > today && due >= start) {
      if (end && due > end) return null;
      return { due, seq: r.seq_offset + n };
    }
    m += step; y += Math.floor(m / 12); m %= 12;
  }
  return null;
}

function renderRules() {
  const wrap = $("rule-list"); wrap.innerHTML = "";
  if (!rules.length) { wrap.innerHTML = `<p class="empty">반복 규칙이 없습니다</p>`; return; }
  for (const r of rules) {
    const b = document.createElement("button");
    b.className = "card-row" + (r.status !== "active" ? " paused" : "");
    b.type = "button";
    const st = { active: "", paused: " · 일시중지", ended: " · 종료" }[r.status];
    const nx = ruleNextDue(r);
    const nxTxt = nx ? ` · 다음 ${nx.due.getMonth() + 1}.${nx.due.getDate()}`
      : r.status === "active" ? " · 종료일 지남" : "";
    b.innerHTML = `<span class="name">${esc(r.name)}</span>
      <span class="sub">${CAD_KO[r.cadence]} ${r.day_of_month}일 · ${fmtEur(r.amount_eur)}${nxTxt}${st}</span>`;
    b.onclick = () => openRuleForm(r);
    wrap.appendChild(b);
  }
}
$("rule-new").addEventListener("click", () => openRuleForm(null));

function openRuleForm(r) {
  const isNew = !r;
  r = r ?? {
    name: "", tx_type: "expense", amount_eur: "", day_of_month: 1, cadence: "monthly",
    start_date: todayStr(), end_date: null, seq_offset: 0, category_id: cats[0]?.id,
    paid_by: me.member_code, memo_template: "", status: "active",
  };
  const catOpts = cats.filter((c) => !c.archived)
    .map((c) => `<option value="${c.id}" ${c.id === r.category_id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const cadOpts = Object.entries(CAD_KO)
    .map(([v, k]) => `<option value="${v}" ${r.cadence === v ? "selected" : ""}>${k}</option>`).join("");
  const whoOpts = ["KM", "MK"]
    .map((w) => `<option value="${w}" ${r.paid_by === w ? "selected" : ""}>${w}</option>`).join("");
  const endLabel = `<label>종료일 (이날까지만 기록, 비우면 계속)<input id="r-endd" type="date" value="${r.end_date ?? ""}"></label>`;
  const memoLabel = `<label>메모 형식 ({n} = 회차)<textarea id="r-memo" rows="1" placeholder="스픽 프리미엄 플러스({n}회),자동이체">${esc(r.memo_template)}</textarea></label>`;

  if (isNew) {
    openModal(`
      <h3>반복 규칙 추가</h3>
      <label>이름<input id="r-name" value="" placeholder="예: 스픽 프리미엄 플러스"></label>
      <div class="row-2">
        <label>금액 (EUR)<input id="r-amt" inputmode="decimal" value=""></label>
        <label>결제일<input id="r-day" type="number" min="1" max="31" value="1"></label>
      </div>
      <div class="row-2">
        <label>주기<select id="r-cad">${cadOpts}</select></label>
        <label>시작일<input id="r-start" type="date" value="${r.start_date}"></label>
      </div>
      <div class="row-2">
        <label>카테고리<select id="r-cat">${catOpts}</select></label>
        <label>결제<select id="r-who">${whoOpts}</select></label>
      </div>
      <label>지난 회차 (엑셀에서 이어받기)<input id="r-seq" type="number" min="0" value="0"></label>
      ${endLabel}
      ${memoLabel}
      <div class="actions">
        <button class="btn-ghost" id="r-cancel">취소</button>
        <button class="btn-primary" id="r-save">저장</button>
      </div>`);
  } else {
    const nx = ruleNextDue(r);
    const usesSeq = r.memo_template === "" || r.memo_template.includes("{n}");
    const heroTxt =
      r.status === "paused" ? "일시중지됨 — 재개하면 밀린 회차가 한꺼번에 기록됩니다" :
      r.status === "ended" ? "종료됨" :
      nx ? `다음 결제 ${nx.due.getFullYear()}.${nx.due.getMonth() + 1}.${nx.due.getDate()} · ${fmtEur(r.amount_eur)}${usesSeq ? ` · ${nx.seq}회` : ""}${r.end_date ? ` · ${r.end_date}까지` : ""}` :
      "종료일이 지나 더 기록되지 않습니다";
    openModal(`
      <h3>반복 규칙</h3>
      <div class="rule-hero">
        <p class="rh-name">${esc(r.name)}</p>
        <p class="rh-next">${heroTxt}</p>
      </div>
      <div class="rule-acts">
        <button type="button" id="ra-amt">금액 변경</button>
        <button type="button" id="ra-pause">${r.status === "active" ? "일시중지" : "재개"}</button>
        ${r.status === "ended" ? "" : `<button type="button" id="ra-end">종료</button>`}
      </div>
      <div id="ra-amt-box" hidden>
        <label>새 금액 (EUR)<input id="r-amt" inputmode="decimal" value="${r.amount_eur}"></label>
        <p class="fine">다음 회차부터 적용됩니다 — 이미 기록된 거래는 바뀌지 않아요.</p>
      </div>
      <details class="rule-adv"><summary>상세 설정</summary>
        <label>이름<input id="r-name" value="${esc(r.name)}"></label>
        <div class="row-2">
          <label>결제일<input id="r-day" type="number" min="1" max="31" value="${r.day_of_month}"></label>
          <label>주기<select id="r-cad">${cadOpts}</select></label>
        </div>
        <div class="row-2">
          <label>카테고리<select id="r-cat">${catOpts}</select></label>
          <label>결제<select id="r-who">${whoOpts}</select></label>
        </div>
        ${endLabel}
        ${memoLabel}
        <p class="fine">시작일 ${r.start_date} · 지난 회차 ${r.seq_offset} — 회차 계산 기준이라 바꿀 수 없어요</p>
        <button type="button" class="btn-ghost danger adv-del" id="r-del">규칙 삭제</button>
      </details>
      <div class="actions">
        <button class="btn-ghost" id="r-cancel">취소</button>
        <button class="btn-primary" id="r-save">저장</button>
      </div>`);
  }

  $("r-cancel").onclick = closeModal;
  const fitMemo = autoGrow($("r-memo"));
  $("modal").querySelector(".rule-adv")?.addEventListener("toggle", fitMemo);

  async function setStatus(status, msg) {
    const { error } = await sb.from("recurring_rules").update({ status }).eq("id", r.id);
    if (error) return toast("실패: " + error.message);
    closeModal(); await loadRefs(); renderRules(); toast(msg);
    if (status === "active") postRecurring();
  }
  if (!isNew) {
    $("ra-amt").onclick = () => {
      const box = $("ra-amt-box");
      box.hidden = !box.hidden;
      if (!box.hidden) $("r-amt").focus();
    };
    $("ra-pause").onclick = () => {
      if (r.status === "active") return setStatus("paused", "일시중지됨");
      if (!confirm("재개하면 멈춘 동안 밀린 회차가 한꺼번에 기록됩니다. 재개할까요?")) return;
      setStatus("active", "재개됨");
    };
    const endBtn = $("ra-end");
    if (endBtn) endBtn.onclick = () => {
      if (!confirm(`"${r.name}" 규칙을 종료할까요? 이후 자동 기록이 멈춥니다.`)) return;
      setStatus("ended", "종료됨");
    };
    $("r-del").onclick = async () => {
      if (!confirm(`"${r.name}" 규칙을 삭제할까요?`)) return;
      const { error } = await sb.from("recurring_rules").delete().eq("id", r.id);
      if (error) return toast("이미 기록된 거래가 있는 규칙은 삭제할 수 없어요 — 대신 '종료'하세요", 3600);
      closeModal(); await loadRefs(); renderRules(); toast("삭제됨");
    };
  }

  $("r-save").onclick = async () => {
    const row = {
      name: $("r-name").value.trim(),
      amount_eur: parseFloat($("r-amt").value.replace(/,/g, ".")),
      day_of_month: parseInt($("r-day").value, 10),
      cadence: $("r-cad").value,
      end_date: $("r-endd").value || null,
      category_id: $("r-cat").value,
      paid_by: $("r-who").value,
      memo_template: $("r-memo").value.trim(),
      tx_type: cats.find((c) => c.id === $("r-cat").value)?.kind === "income" ? "income"
        : (!isNew && r.tx_type === "transfer") ? "transfer" : "expense",
    };
    if (isNew) {
      row.start_date = $("r-start").value;
      row.seq_offset = parseInt($("r-seq").value, 10) || 0;
      row.status = "active";
    }
    if (!row.name || !row.amount_eur || !row.day_of_month) return toast("이름·금액·결제일은 필수예요");
    const startDate = isNew ? row.start_date : r.start_date;
    if (row.end_date && row.end_date < startDate) return toast("종료일이 시작일보다 빠를 수 없어요");
    const q = isNew ? sb.from("recurring_rules").insert(row)
                    : sb.from("recurring_rules").update(row).eq("id", r.id);
    const { error } = await q;
    if (error) return toast("저장 실패: " + error.message);
    closeModal(); await loadRefs(); renderRules(); toast("저장됨");
    postRecurring();
  };
}

// ─────────────────────────────────────────── 더보기 탭
function renderMore() {
  // 여행
  const tw = $("trip-list"); tw.innerHTML = "";
  for (const t of trips) {
    const b = document.createElement("button");
    b.className = "card-row"; b.type = "button";
    b.innerHTML = `<span class="name">${esc(t.name)}</span><span class="sub">${t.start_date} ~ ${t.end_date}</span>`;
    b.onclick = () => openTripForm(t);
    tw.appendChild(b);
  }
  // 계좌
  const aw = $("account-list"); aw.innerHTML = "";
  for (const a of accounts.filter((x) => !x.archived)) {
    const d = document.createElement("div");
    d.className = "card-row";
    d.innerHTML = `<span class="name">${esc(a.name)}</span><span class="sub">${a.type}</span>`;
    aw.appendChild(d);
  }
}
$("trip-new").addEventListener("click", () => openTripForm(null));
function openTripForm(t) {
  const isNew = !t;
  t = t ?? { name: "", start_date: todayStr(), end_date: todayStr() };
  openModal(`
    <h3>${isNew ? "여행 추가" : "여행 수정"}</h3>
    <label>이름<input id="t-name" value="${esc(t.name)}" placeholder="예: 한국 2026 여름"></label>
    <div class="row-2">
      <label>시작<input id="t-start" type="date" value="${t.start_date}"></label>
      <label>끝<input id="t-end" type="date" value="${t.end_date}"></label>
    </div>
    <div class="actions">
      ${isNew ? "" : `<button class="btn-ghost danger" id="t-del">삭제</button>`}
      <button class="btn-ghost" id="t-cancel">취소</button>
      <button class="btn-primary" id="t-save">저장</button>
    </div>`);
  $("t-cancel").onclick = closeModal;
  if (!isNew) $("t-del").onclick = async () => {
    if (!confirm(`"${t.name}" 여행을 삭제할까요?`)) return;
    const { error } = await sb.from("trips").delete().eq("id", t.id);
    if (error) return toast("이 여행이 태깅된 내역이 있어요 — 해당 내역의 여행을 먼저 해제하세요", 3600);
    closeModal(); await loadRefs(); renderMore(); updateTripNote(); toast("삭제됨");
  };
  $("t-save").onclick = async () => {
    const row = { name: $("t-name").value.trim(), start_date: $("t-start").value, end_date: $("t-end").value };
    if (!row.name) return toast("이름을 입력하세요");
    if (row.end_date < row.start_date) return toast("기간을 확인하세요");
    const q = isNew ? sb.from("trips").insert(row) : sb.from("trips").update(row).eq("id", t.id);
    const { error } = await q;
    if (error) return toast("저장 실패");
    closeModal(); await loadRefs(); renderMore(); updateTripNote(); toast("저장됨");
  };
}

// ─────────────────────────────────────────── 자산 탭 (4단계 축소판 — 자동 시세 없음)
// 공식 기록은 월 1회 손 스냅샷뿐. IPS 목표·허용 범위는 앱 상수(IPS 변경은 서면 절차).
// 기준: 통합 확정안 v3 (2026-08-23). 전제조건(① KM 소득상실보험 ② KM IPS 공동서명) 충족
// 전에는 임시 70/30 — 충족되면 아래를 { target: 80, lo: 75, hi: 85 }로 수정 (v3 6쪽).
const IPS_STOCK = { target: 70, lo: 65, hi: 75 };  // 주식 비중 %, 분모 = 주식+채권(현금 제외)
const IPS_SINGLE_CAP = 10;                         // 단일 종목 상한 % (v3 연 1회 체크리스트)
const CLS_KO = { core: "주식 코어", nasdaq: "나스닥", satellite: "위성", bond: "국채", cash: "현금" };
const OWNER_ORDER = ["MK", "KM"];        // 스냅샷 기입 순서 — 정기 투자하는 민경 계좌 먼저

let holdings = [];   // 보관 포함 전체
let snaps = [];      // portfolio_snapshots 전체 (월×종목 수준이라 수백 행 규모)
let trInterest = [];

async function loadPortfolio() {
  const [h, s, i] = await Promise.all([
    sb.from("holdings").select("*").order("sort"),
    sb.from("portfolio_snapshots").select("*").order("ym"),
    sb.from("tr_interest").select("*").is("deleted_at", null)
      .order("int_date", { ascending: false }).limit(200),
  ]);
  if (h.error || s.error || i.error) throw (h.error ?? s.error ?? i.error);
  holdings = h.data; snaps = s.data; trInterest = i.data;
}
const holdingOf = (id) => holdings.find((h) => h.id === id);
// TR 앱 표기("52.300,00")·영미 표기("52,300.00")·소수점 쉼표("4,10") 모두 안전 파싱
function parseEuroNum(s) {
  s = String(s ?? "").trim().replace(/[€\s]/g, "");
  const dot = s.lastIndexOf("."), com = s.lastIndexOf(",");
  if (dot !== -1 && com !== -1) s = com > dot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else s = s.replace(/,/g, ".");
  return parseFloat(s);
}
const snapValue = (hid, ym) => {
  const s = snaps.find((x) => x.holding_id === hid && x.ym === ym);
  return s ? Number(s.value_eur) : null;
};

async function renderAssets() {
  const body = $("as-body");
  body.innerHTML = `<p class="empty">불러오는 중…</p>`;
  try { await loadPortfolio(); }
  catch (e) {
    const missing = /does not exist|relation|schema cache/i.test(e.message ?? "");
    body.innerHTML = `<p class="empty">불러오기 실패${missing ? " — migrations/006_portfolio.sql을 SQL Editor에서 먼저 실행하세요" : ""}</p>`;
    return;
  }

  const curYm = todayStr().slice(0, 7);
  const byYm = {};
  for (const s of snaps) {
    if (!holdingOf(s.holding_id)) continue;
    byYm[s.ym] = (byYm[s.ym] ?? 0) + Number(s.value_eur);
  }
  const ymList = Object.keys(byYm).sort();
  const lastYm = ymList[ymList.length - 1] ?? null;

  // 마지막 스냅샷 달 기준 자산군 합계 (비중·종목 리스트의 단일 기준 시점)
  const clsSum = {};
  let total = 0;
  let maxSat = null;   // 단일 종목 점검 — 위성 종목 중 최대
  if (lastYm) for (const s of snaps.filter((x) => x.ym === lastYm)) {
    const h = holdingOf(s.holding_id); if (!h) continue;
    clsSum[h.asset_class] = (clsSum[h.asset_class] ?? 0) + Number(s.value_eur);
    total += Number(s.value_eur);
    if (h.asset_class === "satellite" && (!maxSat || Number(s.value_eur) > maxSat.v))
      maxSat = { name: h.name, v: Number(s.value_eur) };
  }
  // v3: 비중 분모 = 주식+채권 — TR 현금은 비상금·유보금이라 제외 (v3 5쪽)
  const equity = (clsSum.core ?? 0) + (clsSum.nasdaq ?? 0) + (clsSum.satellite ?? 0);
  const invested = equity + (clsSum.bond ?? 0);
  const stockPct = invested > 0 ? (equity / invested) * 100 : 0;
  const iPct = (v) => (invested > 0 ? (v / invested) * 100 : 0);

  const bandRow = (name, pct, lo, hi, rangeTxt) => {
    const over = (hi != null && pct > hi) || (lo != null && pct < lo);
    const tick = Math.min(pct, 100);
    return `
      <div class="band">
        <div class="r1"><span class="n">${name}</span>
          <span class="v ${over ? "over" : ""}">${pct.toFixed(1)}%<small>${rangeTxt}</small></span></div>
        <div class="band-track"><span class="zone" style="left:${lo ?? 0}%;right:${100 - hi}%"></span><span class="tick ${over ? "over" : ""}" style="left:${tick.toFixed(1)}%"></span></div>
      </div>`;
  };
  const bandRows = invested > 0 ? [
    bandRow("주식 (코어·나스닥·위성)", stockPct, IPS_STOCK.lo, IPS_STOCK.hi,
      `목표 ${IPS_STOCK.target} · ${IPS_STOCK.lo}~${IPS_STOCK.hi}`),
    bandRow("채권 (EUR 헤지)", 100 - stockPct, 100 - IPS_STOCK.hi, 100 - IPS_STOCK.lo,
      `목표 ${100 - IPS_STOCK.target} · ${100 - IPS_STOCK.hi}~${100 - IPS_STOCK.lo}`),
    maxSat ? bandRow("최대 단일 종목", iPct(maxSat.v), null, IPS_SINGLE_CAP,
      `${esc(maxSat.name)} · 상한 ${IPS_SINGLE_CAP}`) : "",
  ].join("") : "";

  const [cy, cm] = curYm.split("-");
  const nudge = lastYm !== curYm
    ? `<div class="as-nudge"><span>${Number(cm)}월 스냅샷이 아직 없어요</span><button type="button" class="today-btn" id="as-snap-new">기록하기</button></div>`
    : `<button type="button" class="btn-ghost as-ghost" id="as-snap-new">${Number(cm)}월 스냅샷 수정</button>`;

  const yearSum = trInterest.filter((t) => t.int_date.startsWith(cy)).reduce((s, t) => s + Number(t.amount_eur), 0);
  const intRows = trInterest.slice(0, 4).map((t) => `
    <button type="button" class="lrow" data-int="${t.id}">
      <span class="d">${Number(t.int_date.slice(5, 7))}.${t.int_date.slice(8, 10)}</span>
      <span class="own-dot ${t.owner.toLowerCase()}"></span>
      <span class="memo">${esc(t.memo || "현금 이자")}</span>
      <span class="amt income">${fmtNum(t.amount_eur)}</span>
    </button>`).join("");

  const holdRows = holdings.filter((h) => !h.archived).concat(holdings.filter((h) => h.archived)).map((h) => {
    const v = lastYm != null ? snapValue(h.id, lastYm) : null;
    return `
      <button type="button" class="lrow${h.archived ? " arch" : ""}" data-hold="${h.id}" ${h.archived ? 'style="opacity:.5"' : ""}>
        <span class="own-dot ${h.owner.toLowerCase()}"></span>
        <span class="cat" style="min-width:0;flex:1;text-align:left">${esc(h.name)}${h.archived ? " (보관)" : ""}</span>
        <span class="cls">${CLS_KO[h.asset_class]}</span>
        <span class="amt">${v == null ? "—" : fmtNum(v)}</span>
      </button>`;
  }).join("");

  body.innerHTML = `
    <div class="sheet as-hero">
      <p class="hv">${total > 0 ? fmtNum(total) + " €" : "—"}</p>
      <p class="hd">${lastYm ? `${lastYm.slice(0, 4)}년 ${Number(lastYm.slice(5))}월 스냅샷 · 두 계좌 합산 · ${ymList.length}회째` : "첫 스냅샷을 기록해 주세요"}</p>
    </div>
    ${nudge}

    <p class="an-sec">IPS 비중 점검 — v3 확정안</p>
    <div class="sheet" style="padding:12px 14px">
      ${invested > 0 ? bandRows + `
      <div class="as-risk"><span>코어 ${iPct(clsSum.core ?? 0).toFixed(1)} · 나스닥 ${iPct(clsSum.nasdaq ?? 0).toFixed(1)} · 위성 ${iPct(clsSum.satellite ?? 0).toFixed(1)}%</span><span>현금 ${fmtNum(clsSum.cash ?? 0)} € 제외</span></div>`
      : `<p class="empty">스냅샷이 쌓이면 여기서 IPS 허용 범위를 점검해요</p>`}
    </div>
    ${invested > 0 ? `<p class="an-note">두 계좌 합산, 분모는 주식+채권(TR 현금 제외) · 임시 70/30 — 전제조건(KM 보험·공동서명) 충족 시 80/20 · 범위 밖이면 신규 적립 비중부터 조정, 매도는 6개월 뒤에만 검토 (v3 9쪽)</p>` : ""}

    <p class="an-sec">평가액 추이</p>
    <p class="ct-label" id="as-label">&nbsp;</p>
    <div class="sheet" style="padding:12px 14px" id="as-chart">
      ${ymList.length ? "" : `<p class="empty">기록이 없습니다</p>`}
    </div>

    <div class="section-head" style="margin-top:22px"><h2 style="margin:0">TR 이자 · 올해 ${fmtNum(yearSum)} €</h2><button type="button" class="btn-ghost" id="as-int-new">+ 기입</button></div>
    <div class="sheet">${intRows || `<p class="empty">기록 없음</p>`}</div>
    <p class="an-note">가계 수입에 합산되지 않아요 — 저축률 계산과 분리 (투자 수익)</p>

    <div class="section-head" style="margin-top:22px"><h2 style="margin:0">보유 종목</h2><button type="button" class="btn-ghost" id="as-hold-new">+ 추가</button></div>
    <div class="sheet">${holdRows || `<p class="empty">종목을 먼저 등록하세요</p>`}</div>
    <p class="an-note">펜 색 점 = 계좌 소유자 · 매도한 종목은 삭제 대신 보관 (스냅샷 이력 유지)</p>`;

  if (ymList.length) drawAssetChart(ymList, byYm);
  $("as-snap-new").onclick = () => openSnapshotForm(curYm);
  $("as-int-new").onclick = () => openInterestForm(null);
  $("as-hold-new").onclick = () => openHoldingForm(null);
  body.querySelectorAll("[data-int]").forEach((b) =>
    b.onclick = () => openInterestForm(trInterest.find((t) => t.id === b.dataset.int)));
  body.querySelectorAll("[data-hold]").forEach((b) =>
    b.onclick = () => openHoldingForm(holdings.find((h) => h.id === b.dataset.hold)));
}

function drawAssetChart(ymList, byYm) {
  const vals = ymList.map((k) => byYm[k]);
  const W = 340, H = 150, L = 8, R = 8, T = 18, B = 20;
  const n = vals.length;
  const max = Math.max(...vals, 1);
  const x = (i) => (n === 1 ? W / 2 : L + (i * (W - L - R)) / (n - 1));
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const line = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const step = n === 1 ? W : (W - L - R) / (n - 1);
  const dots = n <= 40
    ? vals.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.6" fill="var(--ink)"/>`).join("") : "";
  const hits = vals.map((v, i) =>
    `<rect data-i="${i}" x="${(x(i) - step / 2).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${H}" fill="transparent"/>`).join("");
  const ticks = ymList.map((k, i) => {
    const mo = Number(k.slice(5));
    const show = n <= 8 || mo === 1 || i === 0;
    if (!show) return "";
    const txt = mo === 1 || i === 0 ? `'${k.slice(2, 4)}.${mo}` : `${mo}월`;
    const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
    return `<text x="${x(i).toFixed(1)}" y="${H - 5}" text-anchor="${anchor}" font-size="9" fill="var(--ink-2)">${txt}</text>`;
  }).join("");
  $("as-chart").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="var(--card-line)"/>
      <path d="${line} L${x(n - 1).toFixed(1)} ${H - B} L${x(0).toFixed(1)} ${H - B} Z" fill="rgba(38,38,32,.07)"/>
      <path d="${line}" fill="none" stroke="var(--ink)" stroke-width="1.8" stroke-linejoin="round"/>
      ${dots}
      <circle id="as-dot" r="4.2" fill="var(--paper)" stroke="var(--ink)" stroke-width="2" visibility="hidden"/>
      ${hits}${ticks}
    </svg>`;
  const dot = $("as-dot");
  const select = (i) => {
    dot.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x(i).toFixed(1));
    dot.setAttribute("cy", y(vals[i]).toFixed(1));
    $("as-label").textContent = `${ymList[i].slice(0, 4)}년 ${Number(ymList[i].slice(5))}월 · ${fmtEur(vals[i])}`;
  };
  $("as-chart").querySelectorAll("rect[data-i]").forEach((rc) =>
    rc.onclick = () => select(Number(rc.dataset.i)));
  select(n - 1);
}

// ── 스냅샷 기입 (같은 달 재기입 = 덮어쓰기) ──
function openSnapshotForm(ym) {
  const curYm = todayStr().slice(0, 7);
  const active = holdings.filter((h) => !h.archived);
  if (!active.length) { toast("종목을 먼저 등록하세요"); return openHoldingForm(null); }

  openModal(`
    <div class="sn-nav">
      <button type="button" class="mo-arrow" id="sn-prev">&#9664;</button>
      <h3 id="sn-title"></h3>
      <button type="button" class="mo-arrow" id="sn-next">&#9654;</button>
    </div>
    <p class="fx-note">TR 앱 → 포트폴리오의 평가액을 그대로 옮겨 적기. 빈칸은 기록하지 않아요.</p>
    <div id="sn-rows"></div>
    <div class="sn-sum"><span>합계</span><span id="sn-total">—</span></div>
    <button class="btn-primary" id="sn-save">기입하기</button>`);

  const prevYmOf = (m) => { const ks = [...new Set(snaps.map((s) => s.ym))].filter((k) => k < m).sort(); return ks[ks.length - 1] ?? null; };

  const render = () => {
    $("sn-title").textContent = `${ym.slice(0, 4)}년 ${Number(ym.slice(5))}월 스냅샷`;
    $("sn-next").disabled = ym >= curYm;
    const prevYm = prevYmOf(ym);
    const wrap = $("sn-rows"); wrap.innerHTML = "";
    for (const code of OWNER_ORDER) {
      const list = active.filter((h) => h.owner === code);
      if (!list.length) continue;
      const g = document.createElement("p");
      g.className = "sn-group " + code.toLowerCase();
      g.innerHTML = `<span class="own-dot ${code.toLowerCase()}"></span>${WHO_NAME[code]} 계좌`;
      wrap.appendChild(g);
      for (const h of list) {
        const cur = snapValue(h.id, ym);
        const prev = prevYm != null ? snapValue(h.id, prevYm) : null;
        const row = document.createElement("div");
        row.className = "sn-row";
        row.innerHTML = `
          <span class="lb">${esc(h.name)}${prev != null ? `<small>${Number(prevYm.slice(5))}월 ${fmtNum(prev)} €</small>` : ""}</span>
          <input inputmode="decimal" data-hid="${h.id}" value="${cur ?? prev ?? ""}" placeholder="0">`;
        wrap.appendChild(row);
      }
    }
    const prevTotal = prevYm != null
      ? snaps.filter((s) => s.ym === prevYm && holdingOf(s.holding_id)).reduce((s2, s) => s2 + Number(s.value_eur), 0) : null;
    const updateSum = () => {
      let sum = 0, any = false;
      wrap.querySelectorAll("input[data-hid]").forEach((inp) => {
        const v = parseEuroNum(inp.value);
        if (!isNaN(v)) { sum += v; any = true; }
      });
      const d = prevTotal != null ? sum - prevTotal : null;
      $("sn-total").innerHTML = any
        ? `${fmtNum(sum)} €${d != null ? ` <span class="${d >= 0 ? "plus" : ""}">(${d >= 0 ? "+" : "−"}${fmtNum(Math.abs(d))})</span>` : ""}`
        : "—";
    };
    wrap.querySelectorAll("input[data-hid]").forEach((inp) => inp.addEventListener("input", updateSum));
    updateSum();
  };
  render();

  const shift = (d) => {
    const [yy, mm] = ym.split("-").map(Number);
    const nd = new Date(yy, mm - 1 + d, 1).toLocaleDateString("sv-SE").slice(0, 7);
    if (nd > curYm) return;
    ym = nd; render();
  };
  $("sn-prev").onclick = () => shift(-1);
  $("sn-next").onclick = () => shift(1);

  $("sn-save").onclick = async () => {
    const rows = [];
    $("sn-rows").querySelectorAll("input[data-hid]").forEach((inp) => {
      const v = parseEuroNum(inp.value);
      if (!isNaN(v) && v >= 0) rows.push({ ym, holding_id: inp.dataset.hid, value_eur: Math.round(v * 100) / 100 });
    });
    if (!rows.length) return toast("평가액을 입력하세요");
    const btn = $("sn-save"); btn.disabled = true;
    const { error } = await sb.from("portfolio_snapshots").upsert(rows, { onConflict: "ym,holding_id" });
    btn.disabled = false;
    if (error) return toast("저장 실패: " + error.message);
    closeModal(); renderAssets(); toast(`${Number(ym.slice(5))}월 스냅샷 기록됨`);
  };
}

// ── TR 이자 기입 ──
function openInterestForm(t) {
  const isNew = !t;
  t = t ?? { int_date: todayStr(), owner: me.member_code, amount_eur: "", memo: "" };
  openModal(`
    <h3>${isNew ? "TR 이자 기입" : "TR 이자 수정"}</h3>
    <div class="row-2">
      <label>날짜<input id="i-date" type="date" value="${t.int_date}"></label>
      <label>금액 (EUR)<input id="i-amt" inputmode="decimal" value="${t.amount_eur}"></label>
    </div>
    <label>계좌</label>
    <div class="seg" id="i-owner"></div>
    <label>메모 (선택)<input id="i-memo" value="${esc(t.memo)}" placeholder="현금 이자"></label>
    <div class="actions">
      ${isNew ? "" : `<button class="btn-ghost danger" id="i-del">삭제</button>`}
      <button class="btn-ghost" id="i-cancel">취소</button>
      <button class="btn-primary" id="i-save">저장</button>
    </div>`);
  let owner = t.owner;
  const seg = $("i-owner");
  const renderSeg = () => {
    seg.innerHTML = "";
    for (const code of ["KM", "MK"]) {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `<span class="nib"></span>${WHO_NAME[code]}`;
      b.className = (owner === code ? "on " : "") + code.toLowerCase();
      b.onclick = () => { owner = code; renderSeg(); };
      seg.appendChild(b);
    }
  };
  renderSeg();
  $("i-cancel").onclick = closeModal;
  if (!isNew) $("i-del").onclick = async () => {
    if (!confirm("이 이자 기록을 삭제할까요?")) return;
    const { error } = await sb.from("tr_interest").update({ deleted_at: new Date().toISOString() }).eq("id", t.id);
    if (error) return toast("삭제 실패");
    closeModal(); renderAssets(); toast("삭제됨");
  };
  $("i-save").onclick = async () => {
    const amt = parseEuroNum($("i-amt").value);
    if (!amt || amt <= 0) return toast("금액을 입력하세요");
    const row = {
      int_date: $("i-date").value || todayStr(),
      owner,
      amount_eur: Math.round(amt * 100) / 100,
      memo: $("i-memo").value.trim(),
    };
    const q = isNew ? sb.from("tr_interest").insert(row) : sb.from("tr_interest").update(row).eq("id", t.id);
    const { error } = await q;
    if (error) return toast("저장 실패: " + error.message);
    closeModal(); renderAssets(); toast("저장됨");
  };
}

// ── 종목 관리 (삭제 = 보관) ──
function openHoldingForm(h) {
  const isNew = !h;
  h = h ?? { name: "", owner: me.member_code, asset_class: "core", archived: false };
  const clsOpts = Object.entries(CLS_KO)
    .map(([v, k]) => `<option value="${v}" ${h.asset_class === v ? "selected" : ""}>${k}</option>`).join("");
  const whoOpts = ["KM", "MK"]
    .map((w) => `<option value="${w}" ${h.owner === w ? "selected" : ""}>${WHO_NAME[w]}</option>`).join("");
  openModal(`
    <h3>${isNew ? "종목 추가" : "종목 수정"}</h3>
    <label>이름<input id="h-name" value="${esc(h.name)}" placeholder="예: 글로벌 주식 코어"></label>
    <div class="row-2">
      <label>계좌 소유자<select id="h-owner">${whoOpts}</select></label>
      <label>자산군<select id="h-cls">${clsOpts}</select></label>
    </div>
    <p class="fine">자산군에 연결돼야 IPS 비중 점검에 잡혀요. 현금은 비중 분모에만 포함.</p>
    <div class="actions">
      ${isNew ? "" : `<button class="btn-ghost ${h.archived ? "" : "danger"}" id="h-arch">${h.archived ? "복원" : "보관"}</button>`}
      <button class="btn-ghost" id="h-cancel">취소</button>
      <button class="btn-primary" id="h-save">저장</button>
    </div>`);
  $("h-cancel").onclick = closeModal;
  if (!isNew) $("h-arch").onclick = async () => {
    const { error } = await sb.from("holdings").update({ archived: !h.archived }).eq("id", h.id);
    if (error) return toast("실패: " + error.message);
    closeModal(); renderAssets(); toast(h.archived ? "복원됨" : "보관됨 — 스냅샷 이력은 유지돼요");
  };
  $("h-save").onclick = async () => {
    const row = { name: $("h-name").value.trim(), owner: $("h-owner").value, asset_class: $("h-cls").value };
    if (!row.name) return toast("이름을 입력하세요");
    const q = isNew ? sb.from("holdings").insert({ ...row, sort: holdings.length + 1 })
                    : sb.from("holdings").update(row).eq("id", h.id);
    const { error } = await q;
    if (error) return toast(/duplicate|unique/.test(error.message) ? "같은 소유자에 같은 이름이 이미 있어요" : "저장 실패: " + error.message);
    closeModal(); renderAssets(); toast("저장됨");
  };
}

// ── 내보내기 ──
$("export-csv").addEventListener("click", async () => {
  const { data, error } = await sb.from("transactions")
    .select("*").is("deleted_at", null).order("tx_date");
  if (error || !data) return toast("내보내기 실패");
  const rows = [["No", "R/C", "Who", "연월", "날짜", "금액(EUR)", "내역", "카테고리", "원화", "환율", "여행"]];
  for (const t of data) {
    rows.push([
      t.legacy_no ?? "", t.tx_type === "income" ? "R" : "C", t.paid_by,
      t.tx_date.slice(0, 7), t.tx_date, t.amount_eur, t.memo, catName(t.category_id),
      t.orig_currency === "KRW" ? t.orig_amount : "", t.fx_rate ?? "",
      trips.find((x) => x.id === t.trip_id)?.name ?? "",
    ]);
  }
  downloadFile(`pairfolio-${todayStr()}.csv`,
    "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"), "text/csv");
});
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
$("export-snap").addEventListener("click", async () => {
  try { await loadPortfolio(); } catch { return toast("내보내기 실패 — 006_portfolio.sql 실행 여부를 확인하세요"); }
  if (!snaps.length && !trInterest.length) return toast("내보낼 자산 기록이 없습니다");
  const rows = [["구분", "날짜", "소유자", "항목", "자산군", "금액(EUR)"]];
  for (const s of snaps) {
    const h = holdingOf(s.holding_id); if (!h) continue;
    rows.push(["스냅샷", s.ym, WHO_NAME[h.owner], h.name, CLS_KO[h.asset_class], s.value_eur]);
  }
  for (const t of [...trInterest].reverse()) {
    rows.push(["이자", t.int_date, WHO_NAME[t.owner], t.memo || "현금 이자", "", t.amount_eur]);
  }
  downloadFile(`pairfolio-assets-${todayStr()}.csv`,
    "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"), "text/csv");
});
$("export-json").addEventListener("click", async () => {
  const names = ["transactions", "recurring_rules", "recurring_occurrences", "categories", "accounts", "trips"];
  const optional = ["holdings", "portfolio_snapshots", "tr_interest"];  // 006 미실행이어도 백업은 동작
  const dump = { exported_at: new Date().toISOString(), app: "pairfolio" };
  for (const n of names) {
    const { data, error } = await sb.from(n).select("*");
    if (error) return toast("내보내기 실패: " + n);
    dump[n] = data;
  }
  for (const n of optional) {
    const { data, error } = await sb.from(n).select("*");
    if (!error) dump[n] = data;
  }
  downloadFile(`pairfolio-backup-${todayStr()}.json`, JSON.stringify(dump, null, 1), "application/json");
});
function downloadFile(name, content, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(name + " 저장됨");
}

// ─────────────────────────────────────────── 탭 전환
document.querySelectorAll("#tabbar button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#tabbar button").forEach((x) => x.classList.toggle("on", x === b));
    for (const t of ["add", "list", "stats", "assets", "more"]) $("tab-" + t).hidden = t !== b.dataset.tab;
    if (b.dataset.tab === "list") renderList();
    if (b.dataset.tab === "stats") loadRefs().then(renderStats);
    if (b.dataset.tab === "assets") renderAssets();
    if (b.dataset.tab === "more") loadRefs().then(() => { renderRules(); renderMore(); });
  });
});

// 스와이프로 입력 ↔ 내역 전환
let swipeStart = null;
document.addEventListener("touchstart", (e) => {
  swipeStart = null;
  if (!$("modal-wrap").hidden) return;                       // 모달 열려 있으면 무시
  if (e.target.closest("input, textarea, select")) return;   // 입력 중 텍스트 드래그 무시
  swipeStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
document.addEventListener("touchend", (e) => {
  if (!swipeStart) return;
  const dx = e.changedTouches[0].clientX - swipeStart.x;
  const dy = e.changedTouches[0].clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(dx) < 60 || Math.abs(dy) > 50) return;        // 수평으로 충분히 밀었을 때만
  const order = ["add", "list", "stats", "assets", "more"];
  const i = order.indexOf(document.querySelector("#tabbar button.on")?.dataset.tab);
  const next = order[i + (dx < 0 ? 1 : -1)];
  if (i >= 0 && next) document.querySelector(`#tabbar button[data-tab="${next}"]`).click();
}, { passive: true });

// ─────────────────────────────────────────── PWA
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

boot();
