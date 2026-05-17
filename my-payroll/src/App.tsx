import { useState, useEffect, useCallback, useMemo } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const HOURLY_DEFAULT = 10030;
const PAD = (n) => String(n).padStart(2, "0");
const uid = () => Math.random().toString(36).slice(2, 10);
const toMin = (h, m) => h * 60 + m;
const diffHours = (s, e) => { let d = toMin(e.h,e.m)-toMin(s.h,s.m); if(d<0)d+=1440; return +(d/60).toFixed(2); };
const fmtTime = (t) => `${PAD(t.h)}:${PAD(t.m)}`;
const maskRRN = (r) => r ? r.slice(0,6)+"-"+r.slice(6,7)+"******" : "";
const fmtDT = (iso) => { if(!iso) return ""; const d=new Date(iso); return `${d.getMonth()+1}/${d.getDate()} ${PAD(d.getHours())}:${PAD(d.getMinutes())}`; };
const todayObj = () => { const d=new Date(); return {y:d.getFullYear(),m:d.getMonth()+1,d:d.getDate()}; };
const daysInMonth = (y,m) => new Date(y,m,0).getDate();
const dayOfWeek = (y,m,d) => new Date(y,m-1,d).getDay(); // 0=일
const DAY_KR = ["일","월","화","수","목","금","토"];
const DAY_IDX = [0,1,2,3,4,5,6]; // 0=일~6=토

const SHIFT_TYPES = {
  regular:{ label:"정기근무", icon:"🔄", short:"정기" },
  daily:  { label:"일일알바", icon:"📋", short:"일일" },
  sub:    { label:"대타",     icon:"🔀", short:"대타" },
};
const TS = {
  regular:{ badge:"bg-emerald-900/60 text-emerald-300 border-emerald-700", cal:"bg-emerald-900/50 text-emerald-200", dot:"#34d399" },
  daily:  { badge:"bg-sky-900/60 text-sky-300 border-sky-700",             cal:"bg-sky-900/50 text-sky-200",         dot:"#38bdf8" },
  sub:    { badge:"bg-amber-900/60 text-amber-300 border-amber-700",       cal:"bg-amber-900/50 text-amber-200",     dot:"#fbbf24" },
};
// 사람별 칩 색상 팔레트 (emerald≈150, sky≈200, amber≈40 제외)
const CHIP_HUES = [0, 25, 55, 100, 170, 225, 255, 285, 315, 340, 80, 240];

// ─── Storage ──────────────────────────────────────────────────────────────────
// employee.schedules: [{dow:0-6, startH, startM, endH, endM}]
// transfers: {scope:"monthly"|"record", ...}
const SK = "cvs_payroll_v7";
const BLANK = { employees:[], records:[], extras:[], transfers:[], skippedMonths:[] as string[] };
const loadStore = () => { try { const r=localStorage.getItem(SK); if(r) return {...BLANK,...JSON.parse(r)}; } catch {} return BLANK; };
const saveStore = (s) => { try { localStorage.setItem(SK, JSON.stringify(s)); } catch {} };

// ─── Schedule helpers ─────────────────────────────────────────────────────────
// 해당 월의 모든 날짜 중, emp.schedules 요일과 일치하는 날 목록
function scheduledDaysInMonth(emp, y, m) {
  if (!emp.schedules?.length) return [];
  const days = daysInMonth(y, m), result = [];
  for (let d = 1; d <= days; d++) {
    const dow = dayOfWeek(y, m, d);
    const sched = emp.schedules.find(s => s.dow === dow);
    if (sched) result.push({ d, sched });
  }
  return result;
}

// 해당 날짜에 emp의 정기 스케줄이 있는지
function getEmpSched(emp, y, m, d) {
  if (!emp.schedules?.length) return null;
  const dow = dayOfWeek(y, m, d);
  return emp.schedules.find(s => s.dow === dow) || null;
}

// 특정 월에서 스케줄은 있는데 기록이 없는 날/시간 슬롯 목록
// maxDay: 해당 일까지만 체크 (미래 날짜 제외용). 생략 시 월 전체.
function getMissingSlotDays(y, m, allRecs, employees, maxDay?) {
  const limit = maxDay || daysInMonth(y, m);
  const result: {d:number, times:string[]}[] = [];
  for (let d = 1; d <= limit; d++) {
    const dayRecs = allRecs.filter(r => r.year===y && r.month===m && r.day===d);
    const dow = dayOfWeek(y, m, d);
    const dateObj = new Date(y, m-1, d);
    const missingSlots = employees.flatMap(emp => {
      if (emp.hireDate && dateObj < new Date(emp.hireDate)) return [];
      if (emp.resignDate && dateObj > new Date(emp.resignDate)) return [];
      return (emp.schedules||[])
        .filter(s => s.dow===dow)
        .filter(s => !dayRecs.some(r =>
          (r.empId ? r.empId===emp.empId : r.name===emp.name) &&
          r.start.h===s.startH && r.start.m===s.startM
        ))
        .map(s => `${PAD(s.startH)}:${PAD(s.startM)}~${PAD(s.endH)}:${PAD(s.endM)}`);
    });
    const unique = [...new Set<string>(missingSlots)];
    if (unique.length) result.push({d, times: unique});
  }
  return result;
}

// ─── AI (Grok) ────────────────────────────────────────────────────────────────
const GROK_API_KEY = "여기에_GROK_API_KEY_입력"; // xAI 콘솔에서 발급

async function callAI(text, employees) {
  const empList = employees.map(e=>`${e.name}(empId:${e.empId},rrn:${e.rrn||""},기본:${e.defaultShift||"regular"})`).join(", ")||"없음";
  const prompt = `편의점 알바 근무기록 파서. JSON 배열만 반환, 마크다운 없이.
등록직원: ${empList}
필드: empId(등록이면해당id,없으면""), name, rrn(13자리하이픈없이), month, day, startH, startM, endH(익일24이상허용), endM, shiftType("regular"|"daily"|"sub"), subFor(대타원래직원|null), note(null)
shiftType: 대타/대신→sub, 일일/하루/단발→daily, 정기/고정/등록직원→regular, 나머지→daily
텍스트:\n${text}`;

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "grok-3-mini",   // 또는 "grok-3"
      max_tokens: 2000,
      messages: [
        { role: "system", content: "JSON 배열만 반환. 마크다운, 설명 없이." },
        { role: "user", content: prompt },
      ],
    }),
  });
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || "[]";
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ─── Atoms ────────────────────────────────────────────────────────────────────
function ShiftBadge({type,small}) {
  const t=SHIFT_TYPES[type]||SHIFT_TYPES.daily, s=TS[type]||TS.daily;
  return <span className={`inline-flex items-center gap-0.5 border rounded-full font-bold ${small?"text-[10px] px-1.5 py-0":"text-xs px-2 py-0.5"} ${s.badge}`}>{t.icon} {small?t.short:t.label}</span>;
}
function Modal({open,onClose,title,children}) {
  if(!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-t-3xl sm:rounded-2xl p-5 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-extrabold text-zinc-100">{title}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-100 text-2xl w-8 h-8 flex items-center justify-center rounded-full hover:bg-zinc-800">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
const Inp = ({className="",...p}) => <input className={`bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-100 text-sm outline-none focus:border-emerald-500 transition-colors w-full ${className}`} {...p}/>;
const InpSm = ({className="",...p}) => <input className={`bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1 text-zinc-200 text-xs outline-none focus:border-emerald-500 transition-colors ${className}`} {...p}/>;
const Sel = ({className="",children,...p}) => <select className={`bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-100 text-sm outline-none focus:border-emerald-500 w-full ${className}`} {...p}>{children}</select>;
function Btn({children,variant="primary",className="",...p}) {
  const v={
    primary:"bg-gradient-to-br from-emerald-600 to-teal-700 text-white hover:from-emerald-500 hover:to-teal-600 shadow-lg shadow-emerald-900/30",
    ghost:"border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200",
    danger:"border border-red-800 text-red-400 hover:bg-red-950/50",
    amber:"bg-gradient-to-br from-amber-600 to-orange-700 text-white hover:opacity-90 shadow-lg shadow-amber-900/30",
    sky:"bg-gradient-to-br from-sky-600 to-blue-700 text-white hover:opacity-90 shadow-lg shadow-sky-900/30",
    purple:"bg-gradient-to-br from-violet-600 to-purple-700 text-white hover:opacity-90 shadow-lg shadow-violet-900/30",
  };
  return <button className={`rounded-xl font-bold text-sm px-4 py-2.5 transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${v[variant]||v.primary} ${className}`} {...p}>{children}</button>;
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [store, setStore] = useState(loadStore);
  const [tab, setTab]     = useState("calendar");
  const [curY, setCurY]   = useState(todayObj().y);
  const [curM, setCurM]   = useState(todayObj().m);
  const [modal, setModal] = useState(null);

  const [aiText, setAiText]    = useState("");
  const [aiLoading, setAiLoad] = useState(false);
  const [aiItems, setAiItems]  = useState(null);
  const [aiError, setAiError]  = useState("");
  const [savedMsg, setSaved]   = useState("");

  const persist = useCallback(s=>{setStore(s);saveStore(s);},[]);

  const monthRecs = useMemo(()=>store.records.filter(r=>r.year===curY&&r.month===curM),[store.records,curY,curM]);

  // ── 충돌/알림 계산 ────────────────────────────────────────────────────────
  const alerts = useMemo(()=>{
    const msgs=[];
    const days=daysInMonth(curY,curM);
    for(let d=1;d<=days;d++){
      const dayRecs=monthRecs.filter(r=>r.day===d);
      const dailyRecs=dayRecs.filter(r=>r.shiftType==="daily");
      // 정기 스케줄 날에 일일알바가 있으면 알림
      if(dailyRecs.length>0){
        const schedEmps=store.employees.filter(emp=>getEmpSched(emp,curY,curM,d));
        if(schedEmps.length>0){
          msgs.push({type:"daily_conflict",d,msg:`${d}일 — 일일알바 ${dailyRecs.map(r=>r.name).join(", ")} (정기 스케줄: ${schedEmps.map(e=>e.name).join(", ")})`});
        }
      }
    }
    return msgs;
  },[store.employees,monthRecs,curY,curM]);

  // 현재 보는 달: 과거 날짜 한정 체크
  const missingDays = useMemo(()=>{
    const t=todayObj();
    if(curY>t.y||(curY===t.y&&curM>t.m)) return [];
    const maxDay=(curY===t.y&&curM===t.m)?t.d-1:daysInMonth(curY,curM);
    return getMissingSlotDays(curY,curM,store.records,store.employees,maxDay);
  },[store.records,store.employees,curY,curM]);

  // 전달 / 전전달 (선택된 달 기준)
  const prevM=curM===1?12:curM-1, prevY=curM===1?curY-1:curY;
  const prevPrevM=curM<=2?curM+10:curM-2, prevPrevY=curM<=2?curY-1:curY;
  const ymKey=(y,m)=>`${y}-${String(m).padStart(2,'0')}`;

  const prevMonthMissing = useMemo(()=>{
    const t=todayObj();
    if(prevY>t.y||(prevY===t.y&&prevM>t.m)) return [];
    if((store.skippedMonths||[]).includes(ymKey(prevY,prevM))) return [];
    return getMissingSlotDays(prevY,prevM,store.records,store.employees);
  },[store.records,store.employees,store.skippedMonths,prevY,prevM]);

  const prevPrevMonthMissing = useMemo(()=>{
    const t=todayObj();
    if(prevPrevY>t.y||(prevPrevY===t.y&&prevPrevM>t.m)) return [];
    if((store.skippedMonths||[]).includes(ymKey(prevPrevY,prevPrevM))) return [];
    return getMissingSlotDays(prevPrevY,prevPrevM,store.records,store.employees);
  },[store.records,store.employees,store.skippedMonths,prevPrevY,prevPrevM]);

  function skipMonth(ym:string){
    const s=[...(store.skippedMonths||[])];
    if(!s.includes(ym)) s.push(ym);
    persist({...store,skippedMonths:s});
  }

  // 사람별 고유 색상 맵 (empId or name|rrn → hue)
  const personColorMap = useMemo(()=>{
    const map=new Map<string,number>();let idx=0;
    for(const emp of store.employees){map.set(emp.empId,CHIP_HUES[idx%CHIP_HUES.length]);idx++;}
    const extraKeys=[...new Set(store.records.filter(r=>!r.empId).map(r=>`${r.name}|${r.rrn||""}`))].sort();
    for(const k of extraKeys){if(!map.has(k)){map.set(k,CHIP_HUES[idx%CHIP_HUES.length]);idx++;}}
    return map;
  },[store.employees,store.records]);
  const getPersonHue=(empId,name,rrn?)=>{const key=empId||`${name}|${rrn||""}`;return personColorMap.get(key)??220;};

  // ── Record helpers ────────────────────────────────────────────────────────
  function tryPush(snap, rec) {
    const dup=snap.records.find(r=>r.year===rec.year&&r.month===rec.month&&r.day===rec.day&&r.start.h===rec.start.h&&r.start.m===rec.start.m&&(rec.empId?r.empId===rec.empId:r.name===rec.name&&r.rrn===rec.rrn));
    if(dup) return false;
    snap.records=[...snap.records,{...rec,id:uid()}];
    return true;
  }
  function delRecord(id){ persist({...store,records:store.records.filter(r=>r.id!==id)}); }
  function getRecordTransfer(recId){ return store.transfers.find(t=>t.scope==="record"&&t.recordId===recId); }
  function getMonthlyTransfers(empId,name,rrn){ return store.transfers.filter(t=>t.scope==="monthly"&&t.year===curY&&t.month===curM&&(empId?t.empId===empId:t.name===name&&t.rrn===rrn)); }

  function calcStats(){
    const paySum=monthRecs.reduce((s,r)=>s+(r.pay||0),0);
    const extraSum=store.extras.filter(e=>e.year===curY&&e.month===curM).reduce((s,e)=>s+(e.amount||0),0);
    return {paySum,extraSum,total:paySum+extraSum};
  }
  function buildEmpMonthMap(){
    const map={};
    for(const r of monthRecs){
      const k=r.empId||(r.name+"|"+r.rrn);
      if(!map[k]){const emp=store.employees.find(e=>e.empId===r.empId);map[k]={empId:r.empId||null,name:r.name,rrn:r.rrn,bank:emp?.bank,account:emp?.account,hours:0,pay:0,breakdown:{regular:0,daily:0,sub:0},records:[]};}
      map[k].hours+=r.hours;map[k].pay+=r.pay;map[k].breakdown[r.shiftType||"daily"]+=r.pay;map[k].records.push(r);
    }
    return map;
  }
  function buildWorksheetText(){
    const byEmp=buildEmpMonthMap();
    const lines=[`${curY}년 ${curM}월 근무표`,""];
    for(const e of Object.values(byEmp) as any[]){
      lines.push(`${e.name}${e.rrn?` (${maskRRN(e.rrn)})`:""}`);
      const sorted=[...e.records].sort((a,b)=>a.day-b.day);
      for(const r of sorted) lines.push(`  ${r.month}/${r.day} ${PAD(r.start.h)}:${PAD(r.start.m)} ~ ${PAD(r.end.h)}:${PAD(r.end.m)} (${r.hours.toFixed(1)}시간)  ${r.pay.toLocaleString()}원`);
      lines.push(`  소계: ${e.hours.toFixed(1)}시간 / ${e.pay.toLocaleString()}원`);
      lines.push("");
    }
    if(!Object.keys(byEmp).length) return `${curY}년 ${curM}월 근무표\n\n기록 없음`;
    return lines.join("\n").trimEnd();
  }

  // ── 주간 자동 등록 (다음주 월~일, 7일치) ───────────────────────────────
  function autoRegisterWeek() {
    const t=todayObj();
    // 다음주 월요일 계산: 오늘 요일 기준 (0=일,1=월,...,6=토)
    const todayDow=dayOfWeek(t.y,t.m,t.d);
    const daysUntilNextMon=((1-todayDow+7)%7)||7; // 오늘이 월요일이면 7일 후
    const snap={...store,records:[...store.records]};
    let added=0, skipped=0;
    for(let offset=0; offset<7; offset++){
      const date=new Date(t.y,t.m-1,t.d+daysUntilNextMon+offset);
      const y=date.getFullYear(), m=date.getMonth()+1, d=date.getDate();
      for(const emp of store.employees){
        if(!emp.schedules?.length) continue;
        // 입사일 이전 / 퇴사일 이후는 스킵
        if(emp.hireDate && date < new Date(emp.hireDate)) continue;
        if(emp.resignDate && date > new Date(emp.resignDate)) continue;
        const dow=date.getDay();
        const scheds=emp.schedules.filter(s=>s.dow===dow);
        for(const sched of scheds){
          const start={h:sched.startH,m:sched.startM},end={h:sched.endH,m:sched.endM};
          const hours=diffHours(start,end);
          const rec={empId:emp.empId,name:emp.name,rrn:emp.rrn,year:y,month:m,day:d,start,end,hours,hourly:emp.hourly||HOURLY_DEFAULT,pay:Math.round(hours*(emp.hourly||HOURLY_DEFAULT)),shiftType:"regular",subFor:null,note:"자동등록"};
          if(tryPush(snap,rec)) added++; else skipped++;
        }
      }
    }
    persist(snap);
    return {added,skipped};
  }

  // ── AI ────────────────────────────────────────────────────────────────────
  function itemIsDup(r){ return store.records.some(rec=>rec.year===curY&&rec.month===r.month&&rec.day===r.day&&rec.start?.h===r.startH&&rec.start?.m===r.startM&&(r.empId?rec.empId===r.empId:rec.name===r.name&&rec.rrn===r.rrn)); }
  async function handleParse(){
    setAiError("");setAiItems(null);setSaved("");setAiLoad(true);
    try{setAiItems(await callAI(aiText,store.employees));}
    catch(e){setAiError("파싱 실패: "+(e.message||"다시 시도"));}
    setAiLoad(false);
  }
  function updItem(i,k,v){setAiItems(p=>p.map((x,j)=>j===i?{...x,[k]:v}:x));}
  function rmItem(i){setAiItems(p=>p.filter((_,j)=>j!==i));}
  function confirmSave(){
    const snap={...store,records:[...store.records]};
    let added=0,skipped=0;
    for(const r of aiItems){
      const emp=r.empId?store.employees.find(e=>e.empId===r.empId):store.employees.find(e=>e.name===r.name&&e.rrn===r.rrn);
      const hourly=emp?.hourly||HOURLY_DEFAULT,start={h:r.startH,m:r.startM},end={h:r.endH%24,m:r.endM},hours=diffHours(start,end);
      const rec={empId:r.empId||null,name:r.name,rrn:r.rrn,year:curY,month:r.month,day:r.day,start,end,hours,hourly,pay:Math.round(hours*hourly),shiftType:r.shiftType||"daily",subFor:r.subFor||null,note:r.note||null};
      if(tryPush(snap,rec))added++;else skipped++;
    }
    persist(snap);setAiItems(null);setAiText("");setSaved(`✅ ${added}건 저장${skipped?` · 중복 ${skipped}건 스킵`:""}`);
  }

  // ── Calendar ──────────────────────────────────────────────────────────────
  function CalendarView(){
    const days=daysInMonth(curY,curM),firstDow=dayOfWeek(curY,curM,1),t=todayObj();
    const cells=[];for(let i=0;i<firstDow;i++)cells.push(null);for(let d=1;d<=days;d++)cells.push(d);
    const [copied,setCopied]=useState(false);

    return (
      <div>
        {/* 근무표 복사 */}
        <div className="flex justify-end mb-3">
          <button onClick={async()=>{await navigator.clipboard.writeText(buildWorksheetText());setCopied(true);setTimeout(()=>setCopied(false),2000);}} className={`text-xs px-3 py-1.5 rounded-xl border font-bold transition-all ${copied?"border-emerald-600 text-emerald-400 bg-emerald-950/30":"border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"}`}>
            {copied?"✓ 복사됨!":"📋 근무표 복사"}
          </button>
        </div>
        {/* 전달 / 전전달 미입력 알림 */}
        {[{y:prevY,m:prevM,missing:prevMonthMissing},{y:prevPrevY,m:prevPrevM,missing:prevPrevMonthMissing}].map(({y,m,missing})=>{
          if(!missing.length) return null;
          const ym=ymKey(y,m);
          const preview=missing.slice(0,2).map(({d,times})=>`${m}/${d}(${times[0]})`).join(' · ')+(missing.length>2?` 외 ${missing.length-2}건`:'');
          return (
            <div key={ym} className="mb-2 bg-red-950/30 border border-red-900/50 rounded-xl p-3 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-red-400 text-xs font-bold">{y}년 {m}월 — {missing.length}일 미입력</p>
                <p className="text-zinc-500 text-[10px] mt-0.5 truncate">{preview}</p>
              </div>
              <button onClick={()=>skipMonth(ym)} className="shrink-0 text-zinc-500 text-[10px] border border-zinc-700 rounded-lg px-2 py-1 whitespace-nowrap hover:border-zinc-500 hover:text-zinc-300">입력 안함</button>
            </div>
          );
        })}
        {/* 알림 배너 */}
        {alerts.length>0&&(
          <div className="mb-3 space-y-1.5">
            {alerts.slice(0,3).map((a,i)=>(
              <div key={i} className="rounded-xl p-3 flex gap-2 items-start border text-xs bg-amber-950/50 border-amber-800/70 text-amber-300">
                <span>💡</span>
                <span>{a.msg}</span>
              </div>
            ))}
            {alerts.length>3&&<p className="text-zinc-600 text-xs text-center">외 {alerts.length-3}건 알림</p>}
          </div>
        )}
        {missingDays.length>0&&(
          <div className="mb-3 bg-zinc-900 border border-zinc-700 rounded-xl p-3 flex gap-2">
            <span className="text-zinc-500">📅</span>
            <p className="text-zinc-500 text-xs">이번 달 미입력: {missingDays.map(({d,times})=>`${curM}/${d}${times.length?` (${times.join(", ")})`:""}`).join(" · ")}</p>
          </div>
        )}
        {/* 자동 등록 버튼 */}
        {store.employees.some(e=>e.schedules?.length)&&(()=>{
          const t=todayObj();
          const todayDow=dayOfWeek(t.y,t.m,t.d);
          const daysUntilNextMon=((1-todayDow+7)%7)||7;
          const nextMon=new Date(t.y,t.m-1,t.d+daysUntilNextMon);
          const nextSun=new Date(t.y,t.m-1,t.d+daysUntilNextMon+6);
          const monLabel=`${nextMon.getMonth()+1}/${nextMon.getDate()}`;
          const sunLabel=`${nextSun.getMonth()+1}/${nextSun.getDate()}`;
          return (
            <div className="mb-3">
              <Btn variant="purple" className="w-full py-2 text-xs" onClick={()=>{
                const r=autoRegisterWeek();
                alert(`✅ ${r.added}건 자동 등록${r.skipped?` · 중복 ${r.skipped}건 스킵`:""}`);
              }}>🗓️ 다음 주 자동 등록 ({monLabel}~{sunLabel})</Btn>
            </div>
          );
        })()}
        {/* Legend */}
        <div className="flex gap-3 mb-3 flex-wrap">
          {Object.entries(SHIFT_TYPES).map(([k,v])=>(
            <div key={k} className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full" style={{background:TS[k].dot}}/><span className="text-zinc-500 text-xs">{v.label}</span></div>
          ))}
          <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full border border-zinc-600 border-dashed"/><span className="text-zinc-600 text-xs">스케줄</span></div>
        </div>
        <div className="grid grid-cols-7 gap-1 mb-1">
          {DAY_KR.map((d,i)=><div key={d} className={`text-center text-[11px] font-bold py-1 ${i===0?"text-red-400":i===6?"text-sky-400":"text-zinc-600"}`}>{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d,ci)=>{
            if(!d) return <div key={`e${ci}`}/>;
            const recs=monthRecs.filter(r=>r.day===d);
            const isToday=t.y===curY&&t.m===curM&&t.d===d;
            const hasConflict=alerts.some(a=>a.d===d);
            const visibleRecs=recs.slice(0,3);
            const overflow=recs.length-visibleRecs.length;
            return (
              <div key={d} onClick={()=>setModal({type:"day",d})}
                className={`min-h-[74px] rounded-xl p-1.5 cursor-pointer border transition-all
                  ${isToday?"border-amber-500/80 bg-amber-950/25"
                  :hasConflict?"border-amber-800/60 bg-amber-950/10"
                  :"border-zinc-800 bg-zinc-900/40 hover:border-zinc-600"}`}>
                <div className={`text-[11px] font-extrabold mb-0.5 flex items-center gap-0.5 ${dayOfWeek(curY,curM,d)===0?"text-red-400":dayOfWeek(curY,curM,d)===6?"text-sky-400":"text-zinc-300"}`}>
                  {d}
                  {isToday&&<span className="text-amber-400">●</span>}
                  {hasConflict&&<span className="text-amber-400">⚡</span>}
                </div>
                <div className="space-y-0.5">
                  {visibleRecs.map((r)=>{
                    const paid=getRecordTransfer(r.id);
                    const hue=getPersonHue(r.empId,r.name,r.rrn);
                    return <div key={r.id} className="text-[9px] rounded px-1 py-0.5 truncate leading-tight font-bold" style={paid?{background:`hsl(${hue} 55% 18%)`,color:`hsl(${hue} 75% 78%)`}:{background:'transparent',color:`hsl(${hue} 55% 55%)`,border:`1px solid hsl(${hue} 45% 32%)`}}>{r.name}</div>;
                  })}
                  {overflow>0&&<div className="text-[9px] text-zinc-600">+{overflow}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── AI Tab ────────────────────────────────────────────────────────────────
  function AITab(){
    const newCnt=aiItems?aiItems.filter(r=>!itemIsDup(r)).length:0;
    return (
      <div className="space-y-4">
        <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-4 space-y-3">
          <div><p className="text-sm font-extrabold text-zinc-100">🤖 자연어 근무 입력</p><p className="text-zinc-500 text-xs mt-0.5">대타 / 일일 / 정기 자동 구분</p></div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-800/40 p-3 space-y-1">
            <p className="text-[11px] text-zinc-500"><span className="text-emerald-400 font-bold">정기</span> · 홍길동(900101-1234567) 3월5일 09:00~18:00</p>
            <p className="text-[11px] text-zinc-500"><span className="text-sky-400 font-bold">일일</span> · 이준호 일일알바 3월7일 22:00~익일06:00</p>
            <p className="text-[11px] text-zinc-500"><span className="text-amber-400 font-bold">대타</span> · 김영희 대타 3/6 오후2시~10시 원래 박민준</p>
          </div>
          <textarea className="bg-zinc-800 border border-zinc-700 rounded-xl p-3 text-zinc-100 text-sm w-full resize-none outline-none focus:border-emerald-500" rows={5} placeholder="자유롭게 입력..." value={aiText} onChange={e=>{setAiText(e.target.value);setAiItems(null);setAiError("");setSaved("");}}/>
          {aiError&&<p className="text-red-400 text-xs">{aiError}</p>}
          {savedMsg&&<p className="text-emerald-400 text-xs font-bold">{savedMsg}</p>}
          <Btn onClick={handleParse} disabled={aiLoading||!aiText.trim()} className="w-full py-3 text-base">
            {aiLoading?<span className="flex items-center justify-center gap-2"><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>분석 중...</span>:"🤖 AI 파싱 시작"}
          </Btn>
        </div>
        {aiItems&&(
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div><p className="text-sm font-extrabold text-zinc-100">파싱 결과 <span className="text-emerald-400">{aiItems.length}건</span></p>
                <div className="flex gap-2 mt-1 flex-wrap">{Object.entries(SHIFT_TYPES).map(([k,v])=>{const cnt=aiItems.filter(r=>r.shiftType===k).length;if(!cnt)return null;return<span key={k} className={`text-[11px] font-bold border rounded-full px-2 py-0.5 ${TS[k].badge}`}>{v.icon} {v.label} {cnt}건</span>;})}</div>
              </div>
              <span className="text-zinc-600 text-xs">{newCnt}건 신규</span>
            </div>
            {aiItems.map((r,i)=>{
              const emp=r.empId?store.employees.find(e=>e.empId===r.empId):store.employees.find(e=>e.name===r.name&&e.rrn===r.rrn);
              const hourly=emp?.hourly||HOURLY_DEFAULT,hrs=diffHours({h:r.startH,m:r.startM},{h:r.endH%24,m:r.endM}),pay=Math.round(hrs*hourly),dup=itemIsDup(r),s=TS[r.shiftType]||TS.daily;
              return (
                <div key={i} className={`rounded-xl border overflow-hidden ${dup?"border-red-900/50 opacity-50":"border-zinc-700 bg-zinc-900"}`}>
                  <div className="h-1 w-full" style={{background:s.dot}}/>
                  <div className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">{r.name&&<span className="text-zinc-100 font-extrabold">{r.name}</span>}{r.rrn&&<span className="text-zinc-500 text-[11px] mono">{maskRRN(r.rrn)}</span>}<ShiftBadge type={r.shiftType}/>{dup&&<span className="text-[10px] text-red-400 border border-red-800 rounded-full px-2 py-0.5 font-bold">중복</span>}</div>
                      <button onClick={()=>rmItem(i)} className="text-zinc-600 hover:text-red-400 text-xl">×</button>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-2 items-center">
                      <div className="flex items-center gap-1"><span className="text-zinc-500 text-xs">날짜</span><InpSm type="number" className="w-10 text-center" min={1} max={12} value={r.month} onChange={e=>updItem(i,"month",+e.target.value)}/><span className="text-zinc-600 text-xs">월</span><InpSm type="number" className="w-10 text-center" min={1} max={31} value={r.day} onChange={e=>updItem(i,"day",+e.target.value)}/><span className="text-zinc-600 text-xs">일</span></div>
                      <div className="flex items-center gap-1"><InpSm type="number" className="w-10 text-center" min={0} max={23} value={r.startH} onChange={e=>updItem(i,"startH",+e.target.value)}/><span className="text-zinc-600 text-[10px]">:</span><InpSm type="number" className="w-10 text-center" min={0} max={59} value={r.startM} onChange={e=>updItem(i,"startM",+e.target.value)}/><span className="text-zinc-500 text-xs mx-1">~</span><InpSm type="number" className="w-10 text-center" min={0} max={30} value={r.endH} onChange={e=>updItem(i,"endH",+e.target.value)}/><span className="text-zinc-600 text-[10px]">:</span><InpSm type="number" className="w-10 text-center" min={0} max={59} value={r.endM} onChange={e=>updItem(i,"endM",+e.target.value)}/></div>
                    </div>
                    <div className="flex gap-1.5 flex-wrap">{Object.entries(SHIFT_TYPES).map(([k,v])=><button key={k} onClick={()=>updItem(i,"shiftType",k)} className={`text-xs px-2.5 py-1 rounded-full border font-bold transition-all ${r.shiftType===k?TS[k].badge:"border-zinc-700 text-zinc-600 hover:text-zinc-400"}`}>{v.icon} {v.label}</button>)}</div>
                    {r.shiftType==="sub"&&<div className="flex items-center gap-2 bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-2"><span className="text-amber-400 text-xs font-bold shrink-0">원래 담당</span><InpSm className="flex-1 bg-transparent border-none px-0" value={r.subFor||""} onChange={e=>updItem(i,"subFor",e.target.value)}/></div>}
                    <div className="flex justify-between items-center pt-2 border-t border-zinc-800/80"><span className="text-zinc-500 text-xs">{hrs.toFixed(1)}h × {hourly.toLocaleString()}원</span><span className="text-emerald-400 font-extrabold mono text-sm">{pay.toLocaleString()}원</span></div>
                  </div>
                </div>
              );
            })}
            {aiItems.length>0&&<Btn onClick={confirmSave} className="w-full py-3 text-base">✅ {newCnt}건 저장하기{aiItems.length-newCnt>0?` (중복 ${aiItems.length-newCnt}건 제외)`:""}</Btn>}
          </div>
        )}
      </div>
    );
  }

  // ── Employees Tab ─────────────────────────────────────────────────────────
  function EmployeesTab(){
    const EMPTY_FORM={name:"",rrn:"",hourly:HOURLY_DEFAULT,bank:"",account:"",defaultShift:"regular",schedules:[],hireDate:"",resignDate:""};
    const [form,setForm]=useState(EMPTY_FORM);
    const [editId,setEditId]=useState(null); // 스케줄 편집 중인 empId
    const [newSched,setNewSched]=useState({dows:[1],startH:9,startM:0,endH:18,endM:0});

    function resetForm(){ setForm(EMPTY_FORM); }
    function addEmp(){
      if(!form.name) return;
      persist({...store,employees:[...store.employees,{...form,empId:uid()}]});
      resetForm();
    }
    function delEmp(empId){ if(confirm("삭제?")) persist({...store,employees:store.employees.filter(e=>e.empId!==empId)}); }
    function updateEmpSched(empId, schedules){ persist({...store,employees:store.employees.map(e=>e.empId===empId?{...e,schedules}:e)}); }
    function addSched(empId){
      const emp=store.employees.find(e=>e.empId===empId);
      if(!emp||!newSched.dows.length) return;
      const existing=emp.schedules||[];
      const toAdd=newSched.dows
        .filter(dow=>!existing.some(s=>
          s.dow===dow &&
          s.startH===newSched.startH && s.startM===newSched.startM &&
          s.endH===newSched.endH && s.endM===newSched.endM
        ))
        .map(dow=>({...newSched,dow,dows:undefined,id:uid()}));
      if(!toAdd.length) return;
      updateEmpSched(empId,[...existing,...toAdd]);
    }
    function rmSched(empId,schedId){
      const emp=store.employees.find(e=>e.empId===empId);
      updateEmpSched(empId,(emp.schedules||[]).filter(s=>s.id!==schedId));
    }
    function updateEmpDates(empId,hireDate,resignDate){
      persist({...store,employees:store.employees.map(e=>e.empId===empId?{...e,hireDate,resignDate}:e)});
    }
    // 선택된 요일 중 완전 중복인 것들
    function dupDows(emp){
      return (newSched.dows||[]).filter(dow=>
        emp.schedules?.some(s=>
          s.dow===dow &&
          s.startH===newSched.startH && s.startM===newSched.startM &&
          s.endH===newSched.endH && s.endM===newSched.endM
        )
      );
    }
    function toggleDow(i){
      setNewSched(s=>{
        const cur=s.dows||[];
        return {...s, dows: cur.includes(i) ? cur.filter(d=>d!==i) : [...cur,i]};
      });
    }

    return (
      <div className="space-y-4">
        {/* 등록 폼 */}
        <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-4 space-y-3">
          <p className="text-sm font-extrabold text-zinc-100">직원 등록 <span className="text-zinc-500 text-xs font-normal">이름 중복 가능</span></p>
          <div className="grid grid-cols-2 gap-2">
            <Inp placeholder="이름 *" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/>
            <Inp placeholder="주민번호 13자리" value={form.rrn} onChange={e=>setForm({...form,rrn:e.target.value.replace(/\D/g,"").slice(0,13)})}/>
            <Inp placeholder="시급" type="number" value={form.hourly} onChange={e=>setForm({...form,hourly:+e.target.value})}/>
            <Sel value={form.defaultShift} onChange={e=>setForm({...form,defaultShift:e.target.value})}>
              {Object.entries(SHIFT_TYPES).map(([k,v])=><option key={k} value={k}>{v.icon} {v.label}</option>)}
            </Sel>
            <Inp placeholder="은행명" value={form.bank} onChange={e=>setForm({...form,bank:e.target.value})}/>
            <Inp placeholder="계좌번호" value={form.account} onChange={e=>setForm({...form,account:e.target.value})}/>
            <div><label className="text-zinc-500 text-[10px] block mb-0.5">입사일</label><Inp type="date" value={form.hireDate} onChange={e=>setForm({...form,hireDate:e.target.value})}/></div>
            <div><label className="text-zinc-500 text-[10px] block mb-0.5">퇴사일 (선택)</label><Inp type="date" value={form.resignDate} onChange={e=>setForm({...form,resignDate:e.target.value})}/></div>
          </div>
          <Btn onClick={addEmp} className="w-full">등록</Btn>
        </div>

        {/* 직원 목록 */}
        <div className="space-y-3">
          {store.employees.map(emp=>{
            const isEdit=editId===emp.empId;
            return (
              <div key={emp.empId} className="bg-zinc-900 border border-zinc-700 rounded-xl overflow-hidden">
                {/* 직원 헤더 */}
                <div className="p-3 flex justify-between items-start">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-zinc-100 font-bold">{emp.name}</span>
                      <ShiftBadge type={emp.defaultShift||"regular"} small/>
                      <span className="text-zinc-700 text-[10px] mono">#{emp.empId?.slice(0,6)}</span>
                    </div>
                    <p className="text-zinc-500 text-xs mono">{emp.rrn?maskRRN(emp.rrn):"주민번호 미등록"} · {emp.hourly?.toLocaleString()}원/시</p>
                    {emp.bank&&<p className="text-sky-400 text-xs">{emp.bank} {emp.account}</p>}
                    <div className="flex gap-2 flex-wrap">
                      {emp.hireDate&&<span className="text-emerald-500 text-[10px]">입사 {emp.hireDate}</span>}
                      {emp.resignDate&&<span className="text-red-400 text-[10px]">퇴사 {emp.resignDate}</span>}
                    </div>
                    {/* 스케줄 요약 */}
                    {emp.schedules?.length>0&&(
                      <div className="flex gap-1 flex-wrap mt-1">
                        {emp.schedules.map(s=>(
                          <span key={s.id} className="text-[10px] bg-violet-900/50 text-violet-300 border border-violet-800 rounded-full px-1.5 py-0 font-bold">
                            {DAY_KR[s.dow]} {PAD(s.startH)}:{PAD(s.startM)}~{PAD(s.endH)}:{PAD(s.endM)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button onClick={()=>setEditId(isEdit?null:emp.empId)} className={`text-xs px-2 py-1 rounded-lg border font-bold transition-all ${isEdit?"border-violet-600 text-violet-300":"border-zinc-700 text-zinc-500 hover:border-zinc-500"}`}>
                      {isEdit?"닫기":"🗓 스케줄"}
                    </button>
                    <Btn variant="danger" className="text-xs py-1 px-2" onClick={()=>delEmp(emp.empId)}>삭제</Btn>
                  </div>
                </div>

                {/* 스케줄 편집 패널 */}
                {isEdit&&(
                  <div className="border-t border-zinc-800 p-3 bg-zinc-950/40 space-y-3">
                    <p className="text-xs font-extrabold text-violet-300">🗓 정기 스케줄 설정</p>
                    {/* 입사일 / 퇴사일 */}
                    <div className="grid grid-cols-2 gap-2">
                      <div><label className="text-zinc-500 text-[10px] block mb-0.5">입사일</label><Inp type="date" value={emp.hireDate||""} onChange={e=>updateEmpDates(emp.empId,e.target.value,emp.resignDate||"")}/></div>
                      <div><label className="text-zinc-500 text-[10px] block mb-0.5">퇴사일</label><Inp type="date" value={emp.resignDate||""} onChange={e=>updateEmpDates(emp.empId,emp.hireDate||"",e.target.value)}/></div>
                    </div>

                    {/* 기존 스케줄 */}
                    {emp.schedules?.length>0&&(
                      <div className="space-y-1.5">
                        {emp.schedules.map(s=>(
                          <div key={s.id} className="flex items-center justify-between bg-zinc-800 rounded-lg px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span className="text-violet-300 font-bold text-sm w-4">{DAY_KR[s.dow]}</span>
                              <span className="text-zinc-300 text-xs">{PAD(s.startH)}:{PAD(s.startM)} ~ {PAD(s.endH)}:{PAD(s.endM)}</span>
                              <span className="text-zinc-600 text-[10px]">{diffHours({h:s.startH,m:s.startM},{h:s.endH,m:s.endM}).toFixed(1)}h</span>
                            </div>
                            <button onClick={()=>rmSched(emp.empId,s.id)} className="text-zinc-600 hover:text-red-400 text-sm">×</button>
                          </div>
                        ))}
                      </div>
                    )}
                    {!emp.schedules?.length&&<p className="text-zinc-600 text-xs text-center py-1">스케줄 없음</p>}

                    {/* 새 스케줄 추가 */}
                    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 space-y-3">
                      <p className="text-zinc-400 text-[11px] font-extrabold">스케줄 추가 <span className="text-zinc-600 font-normal">요일 여러 개 선택 가능</span></p>

                      {/* 요일 다중 선택 */}
                      <div className="flex gap-1">
                        {DAY_IDX.map(i=>{
                          const isSelected=(newSched.dows||[]).includes(i);
                          const hasSched=emp.schedules?.some(s=>s.dow===i)||false;
                          const isDupForThis=emp.schedules?.some(s=>
                            s.dow===i &&
                            s.startH===newSched.startH && s.startM===newSched.startM &&
                            s.endH===newSched.endH && s.endM===newSched.endM
                          );
                          return (
                            <button key={i} onClick={()=>toggleDow(i)}
                              className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all relative
                                ${isSelected
                                  ? isDupForThis ? "bg-red-900/60 text-red-300 ring-1 ring-red-700" : "bg-violet-700 text-white"
                                  : "bg-zinc-800 text-zinc-500 hover:text-zinc-300"}`}>
                              {DAY_KR[i]}
                              {hasSched&&!isSelected&&(
                                <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-violet-500"/>
                              )}
                              {isSelected&&isDupForThis&&(
                                <span className="absolute -top-1 -right-1 text-[8px] bg-red-600 text-white rounded-full w-3.5 h-3.5 flex items-center justify-center font-black">!</span>
                              )}
                            </button>
                          );
                        })}
                      </div>

                      {/* 선택 요약 + 중복 경고 */}
                      {(newSched.dows||[]).length>0&&(()=>{
                        const dups=dupDows(emp);
                        const newOnes=(newSched.dows||[]).filter(d=>!dups.includes(d));
                        return (
                          <div className="space-y-1">
                            {newOnes.length>0&&(
                              <p className="text-violet-300 text-[11px]">
                                추가될 요일: <span className="font-bold">{newOnes.map(d=>DAY_KR[d]).join(" · ")}</span>
                              </p>
                            )}
                            {dups.length>0&&(
                              <p className="text-red-400 text-[11px]">
                                ⚠ 중복 (스킵됨): <span className="font-bold">{dups.map(d=>DAY_KR[d]).join(" · ")}</span>
                              </p>
                            )}
                          </div>
                        );
                      })()}

                      {/* 시간 입력 */}
                      <div className="flex gap-2 items-center">
                        <div className="flex items-center gap-1 flex-1">
                          <InpSm type="number" className="w-11 text-center" min={0} max={23} value={newSched.startH} onChange={e=>setNewSched(s=>({...s,startH:+e.target.value}))}/>
                          <span className="text-zinc-600 text-xs">:</span>
                          <InpSm type="number" className="w-11 text-center" min={0} max={59} value={newSched.startM} onChange={e=>setNewSched(s=>({...s,startM:+e.target.value}))}/>
                        </div>
                        <span className="text-zinc-500 text-sm">~</span>
                        <div className="flex items-center gap-1 flex-1">
                          <InpSm type="number" className="w-11 text-center" min={0} max={23} value={newSched.endH} onChange={e=>setNewSched(s=>({...s,endH:+e.target.value}))}/>
                          <span className="text-zinc-600 text-xs">:</span>
                          <InpSm type="number" className="w-11 text-center" min={0} max={59} value={newSched.endM} onChange={e=>setNewSched(s=>({...s,endM:+e.target.value}))}/>
                        </div>
                      </div>

                      {/* 요약 + 추가 버튼 */}
                      {(()=>{
                        const hrs=diffHours({h:newSched.startH,m:newSched.startM},{h:newSched.endH,m:newSched.endM});
                        const pay=Math.round(hrs*(emp.hourly||HOURLY_DEFAULT));
                        const dups=dupDows(emp);
                        const newOnes=(newSched.dows||[]).filter(d=>!dups.includes(d));
                        const canAdd=newOnes.length>0&&hrs>0;
                        return (
                          <div className="flex items-center gap-2">
                            <p className="text-zinc-600 text-xs flex-1">{hrs.toFixed(1)}h · {pay.toLocaleString()}원/일</p>
                            <Btn variant="purple" className="shrink-0 text-xs py-1.5 px-4" disabled={!canAdd} onClick={()=>addSched(emp.empId)}>
                              + {newOnes.length}개 추가
                            </Btn>
                          </div>
                        );
                      })()}
                    </div>

                    {/* 자동 등록 버튼 */}
                    {emp.schedules?.length>0&&(()=>{
                      const t=todayObj();
                      const end=new Date(t.y,t.m-1,t.d+6);
                      const endLabel=`${end.getMonth()+1}/${end.getDate()}`;
                      return (
                        <Btn variant="purple" className="w-full py-2 text-xs" onClick={()=>{
                          const snap={...store,records:[...store.records]};
                          let added=0,skipped=0;
                          for(let offset=0;offset<7;offset++){
                            const date=new Date(t.y,t.m-1,t.d+offset);
                            const y=date.getFullYear(),m=date.getMonth()+1,d=date.getDate();
                            const dow=date.getDay();
                            const scheds=emp.schedules.filter(s=>s.dow===dow);
                            for(const sched of scheds){
                              const start={h:sched.startH,m:sched.startM},end2={h:sched.endH,m:sched.endM},hours=diffHours(start,end2);
                              const rec={empId:emp.empId,name:emp.name,rrn:emp.rrn,year:y,month:m,day:d,start,end:end2,hours,hourly:emp.hourly||HOURLY_DEFAULT,pay:Math.round(hours*(emp.hourly||HOURLY_DEFAULT)),shiftType:"regular",subFor:null,note:"자동등록"};
                              if(tryPush(snap,rec))added++;else skipped++;
                            }
                          }
                          persist(snap);
                          alert(`${emp.name} · 오늘~${endLabel} ${added}건 자동 등록${skipped?` (중복 ${skipped}건 스킵)`:""}`);
                        }}>🗓️ {emp.name} — 이번 주 자동 등록 (오늘~{endLabel})</Btn>
                      );
                    })()}
                  </div>
                )}
              </div>
            );
          })}
          {!store.employees.length&&<p className="text-zinc-600 text-sm text-center py-8">등록된 직원 없음</p>}
        </div>
      </div>
    );
  }

  // ── Extras Tab ────────────────────────────────────────────────────────────
  function ExtrasTab(){
    const [form,setForm]=useState({label:"",amount:""});
    const extras=store.extras.filter(e=>e.year===curY&&e.month===curM);
    function add(){if(!form.label||!form.amount)return;persist({...store,extras:[...store.extras,{...form,amount:+form.amount,year:curY,month:curM,id:uid()}]});setForm({label:"",amount:""});}
    return (
      <div className="space-y-4">
        <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-4 space-y-3">
          <p className="text-sm font-extrabold text-zinc-100">{curM}월 추가비용</p>
          <div className="grid grid-cols-2 gap-2"><Inp placeholder="항목 (전기세...)" value={form.label} onChange={e=>setForm({...form,label:e.target.value})}/><Inp placeholder="금액" type="number" value={form.amount} onChange={e=>setForm({...form,amount:e.target.value})}/></div>
          <Btn onClick={add} className="w-full">추가</Btn>
        </div>
        {extras.map(e=>(
          <div key={e.id} className="bg-zinc-900 border border-zinc-700 rounded-xl p-3 flex justify-between items-center">
            <div><p className="text-zinc-100 font-bold">{e.label}</p><p className="text-amber-400 text-sm mono">{e.amount.toLocaleString()}원</p></div>
            <Btn variant="danger" className="text-xs py-1 px-2" onClick={()=>persist({...store,extras:store.extras.filter(x=>x.id!==e.id)})}>삭제</Btn>
          </div>
        ))}
        {!extras.length&&<p className="text-zinc-600 text-sm text-center py-6">추가비용 없음</p>}
      </div>
    );
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function StatsTab(){
    const {paySum,extraSum,total}=calcStats();
    const extras=store.extras.filter(e=>e.year===curY&&e.month===curM);
    const byEmp=buildEmpMonthMap();
    const byType={regular:0,daily:0,sub:0};
    for(const r of monthRecs) byType[r.shiftType||"daily"]+=r.pay;
    const instantPaid=monthRecs.filter(r=>getRecordTransfer(r.id)&&r.shiftType==="daily").reduce((s,r)=>s+r.pay,0);
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          {[{label:"인건비",val:paySum,color:"text-emerald-400"},{label:"추가비용",val:extraSum,color:"text-amber-400"},{label:"총 지출",val:total,color:"text-red-400"}].map(s=>(
            <div key={s.label} className="bg-zinc-900 border border-zinc-700 rounded-xl p-3 text-center"><p className="text-zinc-500 text-xs">{s.label}</p><p className={`${s.color} font-extrabold text-sm mt-1 mono`}>{s.val.toLocaleString()}원</p></div>
          ))}
        </div>
        {instantPaid>0&&(<div className="bg-sky-950/40 border border-sky-800/60 rounded-xl p-3 flex justify-between items-center"><div><p className="text-sky-300 text-xs font-bold">📋 일일알바 즉시지급 완료</p><p className="text-sky-500 text-[11px] mt-0.5">현장 지급됨</p></div><p className="text-sky-400 font-extrabold mono">{instantPaid.toLocaleString()}원</p></div>)}
        <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-4">
          <p className="text-xs font-extrabold text-zinc-400 mb-3">유형별 인건비</p>
          <div className="space-y-3">{Object.entries(SHIFT_TYPES).map(([k,v])=>{if(!byType[k])return null;const pct=paySum?Math.round(byType[k]/paySum*100):0;return(<div key={k}><div className="flex justify-between mb-1.5"><ShiftBadge type={k} small/><span className="text-zinc-300 text-xs font-bold mono">{byType[k].toLocaleString()}원 ({pct}%)</span></div><div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden"><div className="h-full rounded-full" style={{width:`${pct}%`,background:TS[k].dot,transition:"width .6s"}}/></div></div>);})}{!paySum&&<p className="text-zinc-600 text-sm text-center py-2">데이터 없음</p>}</div>
        </div>
        <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-4">
          <p className="text-xs font-extrabold text-zinc-400 mb-3">직원별 집계</p>
          <div className="space-y-3">{Object.values(byEmp).map(e=>(<div key={e.empId||(e.name+e.rrn)} className="pb-3 border-b border-zinc-800 last:border-0 last:pb-0"><div className="flex justify-between items-start"><div><p className="text-zinc-100 font-bold text-sm">{e.name}</p><p className="text-zinc-500 text-xs mono">{maskRRN(e.rrn)}</p></div><p className="text-emerald-400 font-extrabold mono">{e.pay.toLocaleString()}원</p></div><div className="flex gap-2 mt-1.5 flex-wrap items-center">{Object.entries(e.breakdown).map(([k,v])=>{if(!v)return null;return<span key={k} className={`text-[10px] px-1.5 py-0.5 rounded border font-bold ${TS[k].badge}`}>{SHIFT_TYPES[k].short} {v.toLocaleString()}원</span>;})} <span className="text-zinc-600 text-[10px]">총 {e.hours.toFixed(1)}h</span></div></div>))}{!Object.keys(byEmp).length&&<p className="text-zinc-600 text-sm text-center py-2">데이터 없음</p>}</div>
        </div>
        {extras.length>0&&(<div className="bg-zinc-900 border border-zinc-700 rounded-xl p-4"><p className="text-xs font-extrabold text-zinc-400 mb-3">추가비용</p>{extras.map(e=><div key={e.id} className="flex justify-between py-2 border-b border-zinc-800 last:border-0"><span className="text-zinc-400 text-sm">{e.label}</span><span className="text-amber-400 text-sm mono">{e.amount.toLocaleString()}원</span></div>)}</div>)}
      </div>
    );
  }

  // ── Transfer Tab ──────────────────────────────────────────────────────────
  function TransferTab(){
    const [view,setView]=useState("monthly");
    const byEmp=buildEmpMonthMap();

    function MonthlyView(){
      return (
        <div className="space-y-3">
          {Object.entries(byEmp).map(([empKey,e])=>{
            const monthlyTs=getMonthlyTransfers(e.empId,e.name,e.rrn);
            const totalMonthly=monthlyTs.reduce((s,t)=>s+t.amount,0);
            const recordPaid=e.records.filter(r=>getRecordTransfer(r.id)).reduce((s,r)=>s+r.pay,0);
            const totalPaid=totalMonthly+recordPaid,remaining=e.pay-totalPaid,done=remaining<=0;
            return (
              <div key={empKey} className={`bg-zinc-900 border rounded-xl overflow-hidden ${done?"border-emerald-700":"border-zinc-700"}`}>
                {done&&<div className="h-0.5 w-full bg-gradient-to-r from-emerald-500 to-teal-500"/>}
                <div className="p-4 space-y-3">
                  <div className="flex justify-between items-start gap-2">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap"><p className="text-zinc-100 font-extrabold">{e.name}</p>{done&&<span className="text-[10px] bg-emerald-900/60 text-emerald-300 border border-emerald-700 rounded-full px-2 py-0.5 font-bold">✓ 완료</span>}</div>
                      <p className="text-zinc-500 text-xs mono">{maskRRN(e.rrn)}</p>
                      {e.bank&&<p className="text-sky-400 text-xs">{e.bank} {e.account}</p>}
                      <div className="flex gap-1.5 mt-1 flex-wrap">{Object.entries(e.breakdown).map(([k,v])=>{if(!v)return null;return<span key={k} className={`text-[10px] px-1.5 py-0.5 rounded border font-bold ${TS[k].badge}`}>{SHIFT_TYPES[k].short} {v.toLocaleString()}원</span>;})}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-emerald-400 font-extrabold text-lg mono">{e.pay.toLocaleString()}원</p>
                      {recordPaid>0&&<p className="text-sky-400 text-[11px] mono">즉시지급 {recordPaid.toLocaleString()}원</p>}
                      {totalMonthly>0&&<p className="text-emerald-300 text-[11px] mono">송금완료 {totalMonthly.toLocaleString()}원</p>}
                      {!done&&<p className="text-amber-400 text-xs mono font-bold">잔여 {remaining.toLocaleString()}원</p>}
                    </div>
                  </div>
                  {monthlyTs.length>0&&(<div className="space-y-1.5 border-t border-zinc-800 pt-3"><p className="text-zinc-600 text-[11px] font-bold">송금 내역</p>{monthlyTs.map(t=>(<div key={t.id} className="flex justify-between items-center bg-emerald-950/30 border border-emerald-900/40 rounded-lg px-3 py-1.5"><div><p className="text-emerald-300 text-xs font-bold mono">{t.amount.toLocaleString()}원</p><p className="text-zinc-600 text-[10px]">{fmtDT(t.paidAt)}{t.memo&&` · ${t.memo}`}</p></div><button onClick={()=>{if(confirm("삭제?"))persist({...store,transfers:store.transfers.filter(x=>x.id!==t.id)});}} className="text-zinc-700 hover:text-red-500 text-sm">×</button></div>))}</div>)}
                  <Btn variant={done?"ghost":"amber"} className="w-full py-2" onClick={()=>setModal({type:"transfer",info:e,remaining:remaining>0?remaining:0})}>
                    {done?"+ 추가 송금 기록":"💸 송금 기록하기"}
                  </Btn>
                </div>
              </div>
            );
          })}
          {!Object.keys(byEmp).length&&<p className="text-zinc-600 text-sm text-center py-10">이번 달 근무 기록 없음</p>}
        </div>
      );
    }

    function RecordView(){
      const sorted=[...monthRecs].sort((a,b)=>{ if(a.shiftType==="daily"&&b.shiftType!=="daily")return -1; if(a.shiftType!=="daily"&&b.shiftType==="daily")return 1; return a.day-b.day; });
      return (
        <div className="space-y-2">
          <div className="bg-sky-950/40 border border-sky-800/50 rounded-xl p-3 mb-1"><p className="text-sky-300 text-xs font-bold">📋 일일알바는 현장 즉시 지급</p><p className="text-sky-600 text-[11px] mt-0.5">근무 건별로 지급 여부를 표시하세요</p></div>
          {sorted.map(r=>{
            const t=getRecordTransfer(r.id),s=TS[r.shiftType]||TS.daily;
            return (
              <div key={r.id} className={`rounded-xl border overflow-hidden relative ${t?"border-zinc-700 bg-zinc-900/30":"border-zinc-700 bg-zinc-900"}`}>
                <div className="absolute left-0 top-0 bottom-0 w-1" style={{background:t?"#52525b":s.dot}}/>
                <div className="pl-3 p-3 flex justify-between items-center gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap"><span className={`font-bold text-sm ${t?"text-zinc-500 line-through":"text-zinc-100"}`}>{r.name}</span><ShiftBadge type={r.shiftType} small/>{t&&<span className="text-[10px] bg-zinc-800 text-zinc-500 border border-zinc-700 rounded-full px-2 py-0.5 font-bold">✓ 지급완료</span>}</div>
                    <p className="text-zinc-500 text-xs">{r.month}/{r.day} {fmtTime(r.start)}~{fmtTime(r.end)} · {r.hours.toFixed(1)}h</p>
                    {t&&<p className="text-zinc-600 text-[10px]">{fmtDT(t.paidAt)}{t.memo&&` · ${t.memo}`}</p>}
                  </div>
                  <div className="text-right shrink-0 space-y-1.5">
                    <p className={`font-extrabold mono text-sm ${t?"text-zinc-500":"text-emerald-400"}`}>{r.pay.toLocaleString()}원</p>
                    {!t?<Btn variant={r.shiftType==="daily"?"sky":"ghost"} className="text-xs py-1 px-3 whitespace-nowrap" onClick={()=>setModal({type:"recordPay",rec:r})}>{r.shiftType==="daily"?"💵 즉시지급":"💸 개별지급"}</Btn>
                       :<button onClick={()=>{if(confirm("지급 취소?"))persist({...store,transfers:store.transfers.filter(x=>x.id!==t.id)});}} className="text-zinc-700 hover:text-red-500 text-xs border border-zinc-800 rounded-lg px-2 py-1">취소</button>}
                  </div>
                </div>
              </div>
            );
          })}
          {!monthRecs.length&&<p className="text-zinc-600 text-sm text-center py-8">이번 달 근무 기록 없음</p>}
        </div>
      );
    }

    function HistoryView(){
      const hByYM={};
      for(const t of store.transfers){const k=`${t.year}-${PAD(t.month)}`;if(!hByYM[k])hByYM[k]=[];hByYM[k].push(t);}
      const keys=Object.keys(hByYM).sort((a,b)=>b.localeCompare(a));
      return (
        <div className="space-y-4">
          {!keys.length&&<p className="text-zinc-600 text-sm text-center py-6">송금 이력 없음</p>}
          {keys.map(ym=>{const [y,m]=ym.split("-"),list=hByYM[ym],tot=list.reduce((s,t)=>s+t.amount,0);return(
            <div key={ym} className="bg-zinc-900 border border-zinc-700 rounded-xl overflow-hidden">
              <div className="flex justify-between items-center px-4 py-3 border-b border-zinc-800"><p className="text-zinc-100 font-extrabold">{y}년 {+m}월</p><p className="text-emerald-400 font-extrabold mono text-sm">{tot.toLocaleString()}원</p></div>
              <div className="divide-y divide-zinc-800">{list.map(t=>(
                <div key={t.id} className="px-4 py-3 flex justify-between items-start gap-2">
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap"><p className="text-zinc-200 font-bold text-sm">{t.name}</p>{t.scope==="record"?<span className="text-[10px] bg-sky-900/50 text-sky-300 border border-sky-800 rounded-full px-1.5 font-bold">개별지급</span>:<span className="text-[10px] bg-emerald-900/50 text-emerald-300 border border-emerald-800 rounded-full px-1.5 font-bold">월송금</span>}</div>
                    <p className="text-zinc-600 text-xs">{fmtDT(t.paidAt)}{t.memo&&` · ${t.memo}`}</p>
                    {t.scope==="record"&&t.recordDay&&<p className="text-zinc-700 text-[10px]">{t.recordMonth}/{t.recordDay} 근무건</p>}
                  </div>
                  <p className="text-emerald-400 font-extrabold mono shrink-0">{t.amount.toLocaleString()}원</p>
                </div>
              ))}</div>
            </div>
          );})}
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="flex gap-1 bg-zinc-900 border border-zinc-700 rounded-xl p-1">
          {[{id:"monthly",label:"💳 월 단위"},{id:"record",label:"📋 건별 지급"},{id:"history",label:"📜 이력"}].map(v=>(
            <button key={v.id} onClick={()=>setView(v.id)} className={`flex-1 text-xs py-2 rounded-lg font-bold transition-all ${view===v.id?"bg-zinc-700 text-zinc-100":"text-zinc-500 hover:text-zinc-300"}`}>{v.label}</button>
          ))}
        </div>
        {view==="monthly"&&<MonthlyView/>}
        {view==="record"&&<RecordView/>}
        {view==="history"&&<HistoryView/>}
      </div>
    );
  }

  // ── Transfer Modal ────────────────────────────────────────────────────────
  function TransferModal(){
    if(modal?.type!=="transfer") return null;
    const {info,remaining}=modal;
    const [amount,setAmount]=useState(String(remaining||info.pay));
    const [memo,setMemo]=useState("");
    function doTransfer(){
      const amt=+amount;if(!amt||amt<=0)return;
      persist({...store,transfers:[...store.transfers,{id:uid(),scope:"monthly",empId:info.empId||null,name:info.name,rrn:info.rrn,year:curY,month:curM,amount:amt,paidAt:new Date().toISOString(),memo:memo.trim()||null}]});
      setModal(null);
    }
    return (
      <Modal open title="💳 월 단위 송금" onClose={()=>setModal(null)}>
        <div className="space-y-4">
          <div className="bg-zinc-800 rounded-xl p-3"><div className="flex justify-between items-start"><div><p className="text-zinc-100 font-extrabold">{info.name}</p><p className="text-zinc-500 text-xs mono">{maskRRN(info.rrn)}</p>{info.bank&&<p className="text-sky-400 text-xs mt-0.5">{info.bank} {info.account}</p>}</div><div className="text-right"><p className="text-zinc-400 text-xs">이번달 총급여</p><p className="text-emerald-400 font-extrabold mono">{info.pay.toLocaleString()}원</p></div></div>{remaining>0&&<div className="pt-2 border-t border-zinc-700 flex justify-between text-xs mt-2"><span className="text-zinc-500">잔여</span><span className="text-amber-400 mono font-bold">{remaining.toLocaleString()}원</span></div>}</div>
          <div className="flex gap-2 flex-wrap">{[info.pay,remaining>0&&remaining!==info.pay?remaining:null].filter(Boolean).map((v,i)=><button key={i} onClick={()=>setAmount(String(v))} className={`text-xs px-3 py-1.5 rounded-full border font-bold transition-all ${+amount===v?"bg-emerald-700 border-emerald-600 text-white":"border-zinc-600 text-zinc-400 hover:border-zinc-400"}`}>{v===info.pay?"전액":"잔여"} {v.toLocaleString()}원</button>)}</div>
          <div><p className="text-zinc-500 text-xs mb-1">금액</p><Inp type="number" value={amount} onChange={e=>setAmount(e.target.value)}/></div>
          <div><p className="text-zinc-500 text-xs mb-1">메모 (선택)</p><Inp value={memo} onChange={e=>setMemo(e.target.value)} placeholder="카카오페이, 계좌이체..."/></div>
          <div className="flex gap-2"><Btn variant="amber" className="flex-1 py-3" onClick={doTransfer}>💸 송금 완료 기록</Btn><Btn variant="ghost" className="flex-1" onClick={()=>setModal(null)}>취소</Btn></div>
        </div>
      </Modal>
    );
  }

  // ── Record Pay Modal ──────────────────────────────────────────────────────
  function RecordPayModal(){
    if(modal?.type!=="recordPay") return null;
    const {rec}=modal;
    const [amount,setAmount]=useState(String(rec.pay));
    const [memo,setMemo]=useState("");
    const isDaily=rec.shiftType==="daily";
    function doPay(){
      const amt=+amount;if(!amt||amt<=0)return;
      persist({...store,transfers:[...store.transfers,{id:uid(),scope:"record",recordId:rec.id,recordMonth:rec.month,recordDay:rec.day,empId:rec.empId||null,name:rec.name,rrn:rec.rrn,year:curY,month:curM,amount:amt,paidAt:new Date().toISOString(),memo:memo.trim()||null}]});
      setModal(null);
    }
    return (
      <Modal open title={isDaily?"💵 일일알바 즉시지급":"💸 개별 지급 기록"} onClose={()=>setModal(null)}>
        <div className="space-y-4">
          {isDaily&&<div className="bg-sky-950/50 border border-sky-800/60 rounded-xl p-3"><p className="text-sky-300 text-xs font-bold">📋 현장 즉시 지급</p><p className="text-sky-600 text-[11px] mt-0.5">일일알바는 근무 당일 현장에서 바로 지급합니다</p></div>}
          <div className="bg-zinc-800 rounded-xl p-3"><div className="flex justify-between items-start"><div><div className="flex items-center gap-2"><p className="text-zinc-100 font-extrabold">{rec.name}</p><ShiftBadge type={rec.shiftType} small/></div><p className="text-zinc-500 text-xs mt-1">{rec.month}/{rec.day} {fmtTime(rec.start)}~{fmtTime(rec.end)} · {rec.hours.toFixed(1)}h</p></div><p className="text-emerald-400 font-extrabold mono">{rec.pay.toLocaleString()}원</p></div></div>
          <div className="flex gap-2"><button onClick={()=>setAmount(String(rec.pay))} className={`text-xs px-3 py-1.5 rounded-full border font-bold transition-all ${+amount===rec.pay?"bg-emerald-700 border-emerald-600 text-white":"border-zinc-600 text-zinc-400"}`}>전액 {rec.pay.toLocaleString()}원</button></div>
          <div><p className="text-zinc-500 text-xs mb-1">금액</p><Inp type="number" value={amount} onChange={e=>setAmount(e.target.value)}/></div>
          <div><p className="text-zinc-500 text-xs mb-1">메모 (선택)</p><Inp value={memo} onChange={e=>setMemo(e.target.value)} placeholder={isDaily?"현장 현금 지급":"카카오페이, 계좌이체..."}/></div>
          <div className="flex gap-2"><Btn variant={isDaily?"sky":"amber"} className="flex-1 py-3" onClick={doPay}>{isDaily?"💵 즉시지급 완료":"💸 지급 기록"}</Btn><Btn variant="ghost" className="flex-1" onClick={()=>setModal(null)}>취소</Btn></div>
        </div>
      </Modal>
    );
  }

  // ── Day Modal ─────────────────────────────────────────────────────────────
  function DayModal(){
    if(modal?.type!=="day") return null;
    const {d}=modal,recs=monthRecs.filter(r=>r.day===d);
    const schedEmps=store.employees.filter(emp=>getEmpSched(emp,curY,curM,d));
    const [showAdd,setShowAdd]=useState(false);
    const firstEmp=store.employees[0];
    const [form,setForm]=useState({empId:firstEmp?.empId||"",name:firstEmp?.name||"",rrn:firstEmp?.rrn||"",sh:"09",sm:"00",eh:"18",em:"00",shiftType:firstEmp?.defaultShift||"regular",subFor:""});
    function selEmp(empId){const emp=store.employees.find(e=>e.empId===empId);if(emp)setForm(f=>({...f,empId:emp.empId,name:emp.name,rrn:emp.rrn,shiftType:emp.defaultShift||"regular"}));}
    function submitAdd(){
      const start={h:+form.sh,m:+form.sm},end={h:+form.eh,m:+form.em},hours=diffHours(start,end);
      const emp=store.employees.find(e=>e.empId===form.empId),hourly=emp?.hourly||HOURLY_DEFAULT;
      const rec={empId:form.empId||null,name:form.name,rrn:form.rrn,year:curY,month:curM,day:d,start,end,hours,hourly,pay:Math.round(hours*hourly),shiftType:form.shiftType,subFor:form.subFor||null,note:null};
      const snap={...store,records:[...store.records]};
      if(!tryPush(snap,rec)){alert("중복입니다.");return;}
      persist(snap);setShowAdd(false);
    }
    function quickPay(r){persist({...store,transfers:[...store.transfers,{id:uid(),scope:"record",recordId:r.id,recordMonth:r.month,recordDay:r.day,empId:r.empId||null,name:r.name,rrn:r.rrn,year:curY,month:curM,amount:r.pay,paidAt:new Date().toISOString(),memo:null}]});}
    function unpay(recId){const tr=getRecordTransfer(recId);if(tr)persist({...store,transfers:store.transfers.filter(x=>x.id!==tr.id)});}
    const dow=dayOfWeek(curY,curM,d);
    return (
      <Modal open title={`${curM}월 ${d}일 (${DAY_KR[dow]}) 근무`} onClose={()=>setModal(null)}>
        {/* 스케줄 알림 */}
        {schedEmps.length>0&&(
          <div className="mb-4 bg-violet-950/40 border border-violet-800/60 rounded-xl p-3">
            <p className="text-violet-300 text-xs font-bold mb-1">🗓 이날 정기 스케줄</p>
            <div className="space-y-1">
              {schedEmps.map(emp=>{
                const sched=getEmpSched(emp,curY,curM,d);
                const hasRec=recs.some(r=>r.empId===emp.empId||r.name===emp.name);
                return(
                  <div key={emp.empId} className="flex items-center justify-between">
                    <div className="flex items-center gap-2"><span className={`text-xs font-bold ${hasRec?"text-zinc-500":"text-violet-200"}`}>{emp.name}</span><span className="text-zinc-600 text-xs">{PAD(sched.startH)}:{PAD(sched.startM)}~{PAD(sched.endH)}:{PAD(sched.endM)}</span></div>
                    {hasRec?<span className="text-[10px] text-emerald-400 font-bold">✓ 기록있음</span>:<span className="text-[10px] text-red-400 font-bold">기록없음</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="space-y-2 mb-4 max-h-56 overflow-y-auto">
          {recs.map(r=>{
            const s=TS[r.shiftType]||TS.daily,t=getRecordTransfer(r.id);
            return (
              <div key={r.id} className="rounded-xl bg-zinc-800 border border-zinc-700 p-3 overflow-hidden relative">
                <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-xl" style={{background:t?"#52525b":s.dot}}/>
                <div className="pl-3 flex justify-between items-start gap-2">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap"><span className={`font-bold text-sm ${t?"text-zinc-500":"text-zinc-100"}`}>{r.name}</span><ShiftBadge type={r.shiftType} small/></div>
                    <p className="text-zinc-500 text-xs">{fmtTime(r.start)}~{fmtTime(r.end)} · {r.hours.toFixed(1)}h</p>
                    {r.note&&r.note==="자동등록"&&<p className="text-violet-600 text-[10px]">🗓 자동등록</p>}
                    {r.subFor&&<p className="text-amber-400 text-xs">원래 담당: {r.subFor}</p>}
                  </div>
                  <div className="text-right space-y-1.5 shrink-0">
                    <p className={`font-extrabold mono text-sm ${t?"text-zinc-500":"text-emerald-400"}`}>{r.pay.toLocaleString()}원</p>
                    <div className="flex gap-1 justify-end">
                      <button onClick={()=>t?unpay(r.id):quickPay(r)} className={`text-[10px] py-0.5 px-2 rounded-lg border font-bold transition-all whitespace-nowrap ${t?"border-emerald-700/60 text-emerald-500 hover:border-red-700 hover:text-red-400":"border-zinc-600 text-zinc-400 hover:border-emerald-700 hover:text-emerald-400"}`}>{t?"✓ 지급완료":"지급 표시"}</button>
                      <Btn variant="danger" className="text-[10px] py-0.5 px-2" onClick={()=>{delRecord(r.id);setModal({type:"day",d});}}>삭제</Btn>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {!recs.length&&<p className="text-zinc-600 text-sm text-center py-4">기록 없음</p>}
        </div>
        {!showAdd
          ?(
            <div className="space-y-2">
              <Btn onClick={()=>setShowAdd(true)} className="w-full">+ 수동 추가</Btn>
              {/* 스케줄 직원 빠른 추가 */}
              {schedEmps.map(emp=>{
                const sched=getEmpSched(emp,curY,curM,d);
                if(!sched) return null;
                const alreadyAdded=recs.some(r=>r.empId===emp.empId);
                return (
                  <button key={emp.empId} disabled={alreadyAdded}
                    onClick={()=>{
                      const start={h:sched.startH,m:sched.startM},end={h:sched.endH,m:sched.endM},hours=diffHours(start,end);
                      const rec={empId:emp.empId,name:emp.name,rrn:emp.rrn,year:curY,month:curM,day:d,start,end,hours,hourly:emp.hourly||HOURLY_DEFAULT,pay:Math.round(hours*(emp.hourly||HOURLY_DEFAULT)),shiftType:"regular",subFor:null,note:"자동등록"};
                      const snap={...store,records:[...store.records]};
                      if(tryPush(snap,rec)) persist(snap);
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border text-sm font-bold transition-all
                      ${alreadyAdded
                        ? "border-zinc-800 bg-zinc-900/30 text-zinc-600 cursor-not-allowed"
                        : "border-violet-800/60 bg-violet-950/30 text-violet-200 hover:bg-violet-950/60 active:scale-[0.98]"}`}>
                    <span>{emp.name} <span className="text-violet-400 font-normal">{PAD(sched.startH)}:{PAD(sched.startM)}~{PAD(sched.endH)}:{PAD(sched.endM)}</span></span>
                    {alreadyAdded
                      ? <span className="text-[11px] text-zinc-600">✓ 등록됨</span>
                      : <span className="text-[11px] text-violet-400">{Math.round(diffHours({h:sched.startH,m:sched.startM},{h:sched.endH,m:sched.endM})*(emp.hourly||HOURLY_DEFAULT)).toLocaleString()}원 +</span>
                    }
                  </button>
                );
              })}
            </div>
          )
          :(
            <div className="space-y-3 border-t border-zinc-800 pt-4">
              <p className="text-xs font-bold text-zinc-400">수동 추가</p>
              {store.employees.length?<Sel value={form.empId} onChange={e=>selEmp(e.target.value)}>{store.employees.map(e=><option key={e.empId} value={e.empId}>{e.name} ({e.rrn?maskRRN(e.rrn):"주민번호없음"})</option>)}</Sel>
                :<div className="grid grid-cols-2 gap-2"><Inp placeholder="이름" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/><Inp placeholder="주민번호" value={form.rrn} onChange={e=>setForm({...form,rrn:e.target.value.replace(/\D/g,"").slice(0,13)})}/></div>}
              <div className="flex gap-1.5 flex-wrap">{Object.entries(SHIFT_TYPES).map(([k,v])=><button key={k} onClick={()=>setForm({...form,shiftType:k})} className={`text-xs px-2.5 py-1 rounded-full border font-bold transition-all ${form.shiftType===k?TS[k].badge:"border-zinc-700 text-zinc-600"}`}>{v.icon} {v.label}</button>)}</div>
              {form.shiftType==="sub"&&<Inp placeholder="원래 담당 직원 이름" value={form.subFor} onChange={e=>setForm({...form,subFor:e.target.value})}/>}
              <div className="grid grid-cols-2 gap-3">
                <div><p className="text-zinc-500 text-xs mb-1">시작</p><div className="flex gap-1 items-center"><InpSm type="number" className="w-12 text-center" min={0} max={23} value={form.sh} onChange={e=>setForm({...form,sh:e.target.value})}/><span className="text-zinc-600 text-xs">:</span><InpSm type="number" className="w-12 text-center" min={0} max={59} value={form.sm} onChange={e=>setForm({...form,sm:e.target.value})}/></div></div>
                <div><p className="text-zinc-500 text-xs mb-1">종료</p><div className="flex gap-1 items-center"><InpSm type="number" className="w-12 text-center" min={0} max={23} value={form.eh} onChange={e=>setForm({...form,eh:e.target.value})}/><span className="text-zinc-600 text-xs">:</span><InpSm type="number" className="w-12 text-center" min={0} max={59} value={form.em} onChange={e=>setForm({...form,em:e.target.value})}/></div></div>
              </div>
              <div className="flex gap-2"><Btn onClick={submitAdd} className="flex-1">추가</Btn><Btn variant="ghost" onClick={()=>setShowAdd(false)} className="flex-1">취소</Btn></div>
            </div>
          )}
      </Modal>
    );
  }

  // ── Layout ────────────────────────────────────────────────────────────────
  const {total}=calcStats();
  const TABS=[{id:"calendar",label:"📅 달력"},{id:"ai",label:"🤖 AI입력"},{id:"employees",label:"👤 직원"},{id:"extras",label:"💸 추가비용"},{id:"stats",label:"📊 통계"},{id:"transfer",label:"💳 송금"}];
  const alertCount=alerts.length+missingDays.length+prevMonthMissing.length+prevPrevMonthMissing.length;
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100" style={{fontFamily:"'Noto Sans KR',sans-serif"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap');
        *{box-sizing:border-box;} .mono{font-family:'JetBrains Mono','Courier New',monospace;}
        ::-webkit-scrollbar{width:3px;height:3px;} ::-webkit-scrollbar-track{background:#09090b;} ::-webkit-scrollbar-thumb{background:#3f3f46;border-radius:2px;}
        input[type=number]::-webkit-inner-spin-button{opacity:.4;}
      `}</style>
      <div className="sticky top-0 z-40 bg-zinc-950/95 backdrop-blur-md border-b border-zinc-800/80 px-4 py-3">
        <div className="flex items-center justify-between max-w-2xl mx-auto">
          <div>
            <h1 className="text-sm font-black text-zinc-100">편의점 급여관리</h1>
            <p className="text-zinc-600 text-xs">{curY}.{PAD(curM)}</p>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={()=>{if(curM===1){setCurY(curY-1);setCurM(12);}else setCurM(curM-1);}} className="text-zinc-500 hover:text-zinc-100 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-zinc-800 text-lg">‹</button>
            <span className="text-zinc-100 text-sm font-black w-10 text-center">{curM}월</span>
            <button onClick={()=>{if(curM===12){setCurY(curY+1);setCurM(1);}else setCurM(curM+1);}} className="text-zinc-500 hover:text-zinc-100 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-zinc-800 text-lg">›</button>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={()=>setTab("calendar")} className="relative w-8 h-8 flex items-center justify-center rounded-xl hover:bg-zinc-800 text-zinc-500 hover:text-zinc-100 transition-all">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>
              {alertCount>0&&<span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full text-[9px] flex items-center justify-center text-white font-black">{alertCount>9?"!":alertCount}</span>}
            </button>
            <div className="text-right">
              <p className="text-zinc-600 text-xs">총지출</p>
              <p className="text-red-400 font-black text-sm mono">{total.toLocaleString()}원</p>
            </div>
          </div>
        </div>
      </div>
      <div className="flex overflow-x-auto gap-1 px-4 py-2 border-b border-zinc-800/60 max-w-2xl mx-auto" style={{scrollbarWidth:"none"}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} className={`shrink-0 text-xs px-3 py-1.5 rounded-full font-bold transition-all whitespace-nowrap relative ${tab===t.id?"bg-emerald-700 text-white shadow-lg shadow-emerald-900/40":"text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60"}`}>
            {t.label}
            {t.id==="calendar"&&alertCount>0&&<span className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-red-500 rounded-full text-[8px] flex items-center justify-center text-white font-black">{alertCount>9?"!":alertCount}</span>}
          </button>
        ))}
      </div>
      <div className="max-w-2xl mx-auto px-4 py-4 pb-24">
        {tab==="calendar"  &&<CalendarView/>}
        {tab==="ai"        &&<AITab/>}
        {tab==="employees" &&<EmployeesTab/>}
        {tab==="extras"    &&<ExtrasTab/>}
        {tab==="stats"     &&<StatsTab/>}
        {tab==="transfer"  &&<TransferTab/>}
      </div>
      <DayModal/>
      <TransferModal/>
      <RecordPayModal/>
    </div>
  );
}