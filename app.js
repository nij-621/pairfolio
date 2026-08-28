import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);
const fmtEur = (n) => Number(n).toLocaleString("de-AT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
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
  $("modal").innerHTML = html;
  $("modal-wrap").hidden = false;
}
function closeModal() { $("modal-wrap").hidden = true; $("modal").innerHTML = ""; }
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
  $("me-chip").textContent = m.display_name + " (" + m.member_code + ")";
  await loadRefs();
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
const addState = { currency: "EUR", catId: null, who: null };

function initAddForm() {
  addState.who = me.member_code;
  $("add-date").value = todayStr();
  renderCatGrid();
  renderWhoSeg();
  updateTripNote();
}
function activeCats() {
  return cats.filter((c) => !c.archived && c.kind === "expense")
    .concat(cats.filter((c) => !c.archived && c.kind === "income"));
}
function renderCatGrid() {
  const g = $("cat-grid"); g.innerHTML = "";
  for (const c of activeCats()) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = c.name + (c.kind === "income" ? " ↘" : "");
    b.className = addState.catId === c.id ? "on" : "";
    b.onclick = () => { addState.catId = c.id; renderCatGrid(); };
    g.appendChild(b);
  }
}
function renderWhoSeg() {
  const s = $("add-who"); s.innerHTML = "";
  for (const code of ["KM", "MK"]) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = code;
    b.className = (addState.who === code ? "on " : "") + code.toLowerCase();
    b.onclick = () => { addState.who = code; renderWhoSeg(); };
    s.appendChild(b);
  }
}
$("add-currency").addEventListener("click", () => {
  addState.currency = addState.currency === "EUR" ? "KRW" : "EUR";
  const b = $("add-currency");
  b.textContent = addState.currency;
  b.classList.toggle("krw", addState.currency === "KRW");
  $("add-fx-note").hidden = addState.currency !== "KRW";
  if (addState.currency === "KRW") $("add-fx-note").textContent = "원화 입력 — 저장 시 ECB 환율로 자동 환산";
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
  addState.catId = null; renderCatGrid();
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
$("mo-prev").addEventListener("click", () => shiftMonth(-1));
$("mo-next").addEventListener("click", () => shiftMonth(1));
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

async function renderList() {
  if ($("tab-list").hidden && $("mo-label").textContent) { /* 백그라운드 갱신 허용 */ }
  $("mo-label").textContent = listMonth.replace("-", "년 ") + "월";
  const [from, to] = monthRange(listMonth);
  const { data, error } = await sb.from("transactions")
    .select("*").is("deleted_at", null)
    .gte("tx_date", from).lte("tx_date", to)
    .order("tx_date", { ascending: false }).order("created_at", { ascending: false });
  if (error) { $("tx-list").innerHTML = `<p class="empty">불러오기 실패</p>`; return; }

  let spend = 0, income = 0;
  for (const t of data) {
    if (t.tx_type === "expense") spend += Number(t.amount_eur);
    if (t.tx_type === "income") income += Number(t.amount_eur);
  }
  $("mo-summary").innerHTML =
    `<span>지출 <b>${fmtEur(spend)}</b></span><span>수입 <b>${fmtEur(income)}</b></span>`;

  const list = $("tx-list"); list.innerHTML = "";
  if (!data.length) { list.innerHTML = `<p class="empty">이 달 기록이 없습니다</p>`; return; }
  let curDay = "";
  for (const t of data) {
    if (t.tx_date !== curDay) {
      curDay = t.tx_date;
      const h = document.createElement("p");
      h.className = "day-head";
      h.textContent = Number(curDay.slice(8, 10)) + "일";
      list.appendChild(h);
    }
    list.appendChild(txRow(t));
  }
}
function catName(id) { return cats.find((c) => c.id === id)?.name ?? "—"; }
function txRow(t, inTrash = false) {
  const b = document.createElement("button");
  b.className = "tx-row"; b.type = "button";
  const income = t.tx_type === "income";
  b.innerHTML =
    `<span class="cat">${esc(catName(t.category_id))}</span>` +
    `<span class="memo">${esc(t.memo)}</span>` +
    `<span class="who ${t.paid_by.toLowerCase()}">${t.paid_by}</span>` +
    `<span class="amt ${income ? "income" : ""}">${income ? "+" : ""}${fmtEur(t.amount_eur)}</span>`;
  b.onclick = () => (inTrash ? openTrashItem(t) : openEditTx(t));
  return b;
}

function openEditTx(t) {
  const catOpts = cats.filter((c) => !c.archived || c.id === t.category_id)
    .map((c) => `<option value="${c.id}" ${c.id === t.category_id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const tripOpts = ['<option value="">여행 없음</option>']
    .concat(trips.map((x) => `<option value="${x.id}" ${x.id === t.trip_id ? "selected" : ""}>${esc(x.name)}</option>`)).join("");
  openModal(`
    <h3>거래 수정</h3>
    <div class="row-2">
      <label>날짜<input type="date" id="e-date" value="${t.tx_date}"></label>
      <label>금액 (EUR)<input type="text" inputmode="decimal" id="e-amt" value="${t.amount_eur}"></label>
    </div>
    <label>카테고리<select id="e-cat">${catOpts}</select></label>
    <label>메모<input type="text" id="e-memo" value="${esc(t.memo)}"></label>
    <div class="row-2">
      <label>귀속<select id="e-who">
        <option value="KM" ${t.paid_by === "KM" ? "selected" : ""}>KM</option>
        <option value="MK" ${t.paid_by === "MK" ? "selected" : ""}>MK</option>
      </select></label>
      <label>여행<select id="e-trip">${tripOpts}</select></label>
    </div>
    ${t.orig_currency === "KRW" ? `<p class="fx-note">원화 ${Number(t.orig_amount).toLocaleString()}₩ · 환율 ${t.fx_rate} (${t.fx_rate_date})</p>` : ""}
    <div class="actions">
      <button class="btn-ghost danger" id="e-del">휴지통</button>
      <button class="btn-primary" id="e-save">저장</button>
    </div>`);
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
  openModal(`<h3>휴지통</h3><div id="trash-list"></div>`);
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

// ─────────────────────────────────────────── 반복 탭
function renderRules() {
  const wrap = $("rule-list"); wrap.innerHTML = "";
  if (!rules.length) { wrap.innerHTML = `<p class="empty">반복 규칙이 없습니다</p>`; return; }
  for (const r of rules) {
    const b = document.createElement("button");
    b.className = "card-row" + (r.status !== "active" ? " paused" : "");
    b.type = "button";
    const cad = { monthly: "매월", bimonthly: "격월", yearly: "매년" }[r.cadence];
    const st = { active: "", paused: " · 일시중지", ended: " · 종료" }[r.status];
    b.innerHTML = `<span class="name">${esc(r.name)}</span>
      <span class="sub">${cad} ${r.day_of_month}일 · ${fmtEur(r.amount_eur)}${st}</span>`;
    b.onclick = () => openRuleForm(r);
    wrap.appendChild(b);
  }
}
$("rule-new").addEventListener("click", () => openRuleForm(null));

function openRuleForm(r) {
  const isNew = !r;
  r = r ?? {
    name: "", tx_type: "expense", amount_eur: "", day_of_month: 1, cadence: "monthly",
    start_date: todayStr(), seq_offset: 0, category_id: cats[0]?.id, paid_by: me.member_code,
    memo_template: "", status: "active",
  };
  const catOpts = cats.filter((c) => !c.archived)
    .map((c) => `<option value="${c.id}" ${c.id === r.category_id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  openModal(`
    <h3>${isNew ? "반복 규칙 추가" : "반복 규칙 수정"}</h3>
    <label>이름<input id="r-name" value="${esc(r.name)}" placeholder="예: 스픽 프리미엄 플러스"></label>
    <div class="row-2">
      <label>금액 (EUR)<input id="r-amt" inputmode="decimal" value="${r.amount_eur}"></label>
      <label>결제일<input id="r-day" type="number" min="1" max="31" value="${r.day_of_month}"></label>
    </div>
    <div class="row-2">
      <label>주기<select id="r-cad">
        <option value="monthly" ${r.cadence === "monthly" ? "selected" : ""}>매월</option>
        <option value="bimonthly" ${r.cadence === "bimonthly" ? "selected" : ""}>격월</option>
        <option value="yearly" ${r.cadence === "yearly" ? "selected" : ""}>매년</option>
      </select></label>
      <label>시작일<input id="r-start" type="date" value="${r.start_date}"></label>
    </div>
    <div class="row-2">
      <label>카테고리<select id="r-cat">${catOpts}</select></label>
      <label>귀속<select id="r-who">
        <option value="KM" ${r.paid_by === "KM" ? "selected" : ""}>KM</option>
        <option value="MK" ${r.paid_by === "MK" ? "selected" : ""}>MK</option>
      </select></label>
    </div>
    <div class="row-2">
      <label>지난 회차 (엑셀에서 이어받기)<input id="r-seq" type="number" min="0" value="${r.seq_offset}"></label>
      <label>상태<select id="r-status">
        <option value="active" ${r.status === "active" ? "selected" : ""}>진행</option>
        <option value="paused" ${r.status === "paused" ? "selected" : ""}>일시중지</option>
        <option value="ended" ${r.status === "ended" ? "selected" : ""}>종료</option>
      </select></label>
    </div>
    <label>메모 형식 ({n} = 회차)<input id="r-memo" value="${esc(r.memo_template)}" placeholder="스픽 프리미엄 플러스({n}회),자동이체"></label>
    <div class="actions">
      <button class="btn-ghost" id="r-cancel">취소</button>
      <button class="btn-primary" id="r-save">저장</button>
    </div>`);
  $("r-cancel").onclick = closeModal;
  $("r-save").onclick = async () => {
    const row = {
      name: $("r-name").value.trim(),
      amount_eur: parseFloat($("r-amt").value.replace(/,/g, ".")),
      day_of_month: parseInt($("r-day").value, 10),
      cadence: $("r-cad").value,
      start_date: $("r-start").value,
      seq_offset: parseInt($("r-seq").value, 10) || 0,
      category_id: $("r-cat").value,
      paid_by: $("r-who").value,
      memo_template: $("r-memo").value.trim(),
      status: $("r-status").value,
      tx_type: cats.find((c) => c.id === $("r-cat").value)?.kind === "income" ? "income" : "expense",
    };
    if (!row.name || !row.amount_eur || !row.day_of_month) return toast("이름·금액·결제일은 필수예요");
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
      <button class="btn-ghost" id="t-cancel">취소</button>
      <button class="btn-primary" id="t-save">저장</button>
    </div>`);
  $("t-cancel").onclick = closeModal;
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
$("export-json").addEventListener("click", async () => {
  const names = ["transactions", "recurring_rules", "recurring_occurrences", "categories", "accounts", "trips"];
  const dump = { exported_at: new Date().toISOString(), app: "pairfolio" };
  for (const n of names) {
    const { data, error } = await sb.from(n).select("*");
    if (error) return toast("내보내기 실패: " + n);
    dump[n] = data;
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
    for (const t of ["add", "list", "rules", "more"]) $("tab-" + t).hidden = t !== b.dataset.tab;
    if (b.dataset.tab === "list") renderList();
    if (b.dataset.tab === "rules") loadRefs().then(renderRules);
    if (b.dataset.tab === "more") loadRefs().then(renderMore);
  });
});

// ─────────────────────────────────────────── PWA
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

boot();
