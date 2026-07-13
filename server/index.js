import express from 'express'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import ExcelJS from 'exceljs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const seedDataDir = path.join(__dirname, '../data')
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : seedDataDir
const dataFile = path.join(dataDir, 'bookings.json')
const servicesFile = path.join(dataDir, 'services.json')
const settingsFile = path.join(dataDir, 'settings.json')
const importTaskFile = path.join(dataDir, 'import-task.json')
const app = express()
const PORT = process.env.PORT || 3001
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'fhy'
const runningImportTasks = new Set()

app.use(express.json())

async function ensureDataDir() { await fs.mkdir(dataDir, { recursive: true }) }
function retainedBookings(bookings) {
  const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1)
  const cutoffDate = cutoff.toISOString().slice(0, 10)
  return bookings.filter(booking => String(booking.date || '') >= cutoffDate)
}
async function readBookings() {
  try {
    const stored = JSON.parse(await fs.readFile(dataFile, 'utf8'))
    const retained = retainedBookings(Array.isArray(stored) ? stored : [])
    if (retained.length !== stored.length) await writeBookings(retained)
    return retained
  } catch (error) {
    if (error.code === 'ENOENT') { await ensureDataDir(); await fs.writeFile(dataFile, '[]'); return [] }
    throw error
  }
}

async function writeBookings(bookings) {
  await ensureDataDir()
  const temp = `${dataFile}.tmp`
  await fs.writeFile(temp, JSON.stringify(retainedBookings(bookings), null, 2))
  await fs.rename(temp, dataFile)
}
async function readServices() { try{return JSON.parse(await fs.readFile(servicesFile,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error;await ensureDataDir();const defaults=JSON.parse(await fs.readFile(path.join(seedDataDir,'services.json'),'utf8'));await fs.writeFile(servicesFile,JSON.stringify(defaults,null,2));return defaults} }
async function writeServices(services) { await ensureDataDir();const temp=`${servicesFile}.tmp`; await fs.writeFile(temp, JSON.stringify(services,null,2)); await fs.rename(temp,servicesFile) }
async function readSettings() {
  const defaults = {
    announcement: '預約時間：早上 9:00 開始，晚上最晚預約時間 20:00。22:00 過後預約額外加 200 元。',
    googleSheetUrl: 'https://docs.google.com/spreadsheets/d/1T4lMv1PocK4PRN6JRp1vMyrTaEjou2F70TZgf_43IRM/edit?usp=drivesdk'
  }
  try { return { ...defaults, ...JSON.parse(await fs.readFile(settingsFile, 'utf8')) } } catch (error) {
    if (error.code === 'ENOENT') { await ensureDataDir();await fs.writeFile(settingsFile, JSON.stringify(defaults, null, 2)); return defaults }
    throw error
  }
}
async function writeSettings(settings) { await ensureDataDir();const temp=`${settingsFile}.tmp`; await fs.writeFile(temp,JSON.stringify(settings,null,2)); await fs.rename(temp,settingsFile) }
async function readImportTask() { try{return JSON.parse(await fs.readFile(importTaskFile,'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw error} }
async function writeImportTask(task) { await ensureDataDir();const temp=`${importTaskFile}.tmp`; await fs.writeFile(temp,JSON.stringify(task,null,2)); await fs.rename(temp,importTaskFile) }
async function latestImportTask() {
  const task=await readImportTask()
  if(task?.status==='running'&&!runningImportTasks.has(task.id)){
    task.status='error';task.error='上一次同步因服務重啟而中斷，請重新開始同步。';task.updatedAt=new Date().toISOString();task.finishedAt=task.updatedAt
    task.progress=[...(task.progress||[]),{id:crypto.randomUUID(),message:task.error,status:'error',time:new Date().toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}]
    await writeImportTask(task)
  }
  return task
}
function isAdmin(req) { return req.headers['x-admin-password'] === ADMIN_PASSWORD }

function minutesOf(value) { const [h, m] = value.split(':').map(Number); return h * 60 + m }
function minutesToClock(value) { return `${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}` }
function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && bStart < aEnd }
function publicBooking(b) { return { id: b.id, date: b.date, startTime: b.startTime, endTime: b.endTime, services: b.services, displayName: `${b.name.trim().slice(0, 1)}小姐` } }
function scheduleBooking(b) { return { id:b.id,date:b.date,startTime:b.startTime,endTime:b.endTime } }
function sheetCsvUrl(value) { const match=String(value||'').match(/spreadsheets\/d\/([\w-]+)/); return match ? `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv` : null }
function normalizeAiRecord(record) {
  const type=record.type==='leave'?'leave':'booking', date=String(record.date||''), startTime=String(record.startTime||''), endTime=String(record.endTime||'')
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(startTime)||!/^\d{2}:\d{2}$/.test(endTime)||minutesOf(startTime)>=minutesOf(endTime))return null
  return {type,date,startTime,endTime,services:type==='leave'?['休假']:(Array.isArray(record.services)?record.services.map(String):['Google 匯入']),name:type==='leave'?'休假':String(record.name||'Google 匯入'),phone:'',note:String(record.note||record.raw||''),source:'google-sheet'}
}
async function askDeepSeek(prompt){
  let lastError
  for(let attempt=0;attempt<2;attempt++)try{
    const response=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}`},body:JSON.stringify({model:attempt===0?'deepseek-v4-flash':'deepseek-v4-pro',messages:[{role:'user',content:prompt}],response_format:{type:'json_object'},temperature:0,max_tokens:5000})})
    const body=await response.json();if(!response.ok)throw new Error(body.error?.message||'DeepSeek API 錯誤')
    const content=body.choices?.[0]?.message?.content;if(!content)throw new Error('DeepSeek 回傳空白內容')
    return JSON.parse(content)
  }catch(error){lastError=error}
  throw lastError
}

async function buildGoogleImportRecords({url:rawUrl,year:rawYear,onProgress=()=>{}}){
  const settings=await readSettings(), url=sheetCsvUrl(rawUrl||settings.googleSheetUrl), year=Number(rawYear)||new Date().getFullYear()
  if(!url)throw new Error('Google 表格連結格式不正確。')
  await onProgress('正在讀取 Google 預約表…')
  const sheetResponse=await fetch(url);if(!sheetResponse.ok)throw new Error('無法讀取 Google 表格，請確認連結可公開檢視。')
  const csv=await sheetResponse.text(), services=await readServices(), dateLines=csv.split(/\r?\n/).filter(line=>/^\d{1,2}\/\d{1,2},/.test(line.trim()))
  await onProgress(`已讀取表格，找到 ${dateLines.length} 行日期資料。`)
  const chunks=[];for(let i=0;i<dateLines.length;i+=5)chunks.push(dateLines.slice(i,i+5).join('\n'))
  const instructions=`你是台灣美甲預約資料整理助手。把 CSV 轉成 json，年份是 ${year}。只輸出 {"records":[]} JSON。每個有時間的預約是一筆 booking，日期為 YYYY-MM-DD，時間為 HH:mm。services 只能是：${services.map(s=>s.name).join('、')}。手=手部美甲，足=足部美甲，卸=卸甲。endTime 按服務時間加總：${services.map(s=>`${s.name}${s.minutes}分鐘`).join('、')}；項目不明預設 120 分鐘。「休假」「有事」「勿約」轉 leave；沒時間為 09:00–22:00，早上為 09:00–13:00，某時間後到 22:00，明確範圍照原文。name 只填明確人名，否則「Google 匯入」。note 保留原始格文字。不要產生標題或公告。範例：{"records":[{"type":"booking","date":"${year}-07-01","startTime":"10:30","endTime":"13:30","services":["卸甲","手部美甲"],"name":"Google 匯入","note":"10：30卸+手"},{"type":"leave","date":"${year}-07-17","startTime":"09:00","endTime":"22:00","services":[],"name":"休假","note":"休假"}]}`
  const parsedChunks=[]
  for(let index=0;index<chunks.length;index++){
    await onProgress(`正在請 DeepSeek 辨識第 ${index+1}/${chunks.length} 段資料…`)
    const parsed=await askDeepSeek(`${instructions}\nCSV：\n${chunks[index]}`)
    parsedChunks.push(parsed)
    const count=Array.isArray(parsed.records)?parsed.records.length:0
    await onProgress(`第 ${index+1}/${chunks.length} 段完成，識別 ${count} 筆。`)
  }
  await onProgress('正在檢查重複與時段衝突…')
  const normalized=parsedChunks.flatMap(parsed=>Array.isArray(parsed.records)?parsed.records:[]).map(normalizeAiRecord).filter(Boolean), bookings=await readBookings()
  const statusOrder={conflict:0,duplicate:1,ready:2}
  return normalized.map((record,index)=>{const signature=`${record.date}|${record.startTime}|${record.endTime}|${record.type}|${record.note}`;const duplicate=bookings.some(b=>b.importSignature===signature);const conflict=!duplicate&&bookings.some(b=>b.date===record.date&&overlaps(minutesOf(record.startTime),minutesOf(record.endTime),minutesOf(b.startTime),minutesOf(b.endTime)));return {...record,tempId:`import-${index}`,status:duplicate?'duplicate':conflict?'conflict':'ready'}}).sort((a,b)=>statusOrder[a.status]-statusOrder[b.status]||`${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`))
}

async function runImportTask(task){
  runningImportTasks.add(task.id)
  const progress=async(message,status='working')=>{
    task.progress.push({id:crypto.randomUUID(),message,status,time:new Date().toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',second:'2-digit'})})
    task.updatedAt=new Date().toISOString()
    await writeImportTask(task)
  }
  try{
    await progress('準備開始匯入…')
    const records=await buildGoogleImportRecords({...task.params,onProgress:progress})
    task.status='done';task.records=records;task.updatedAt=new Date().toISOString();task.finishedAt=task.updatedAt
    await progress(`辨識完成，共 ${records.length} 筆。`,'done')
  }catch(error){
    task.status='error';task.error=`DeepSeek 匯入失敗：${error.message}`;task.updatedAt=new Date().toISOString();task.finishedAt=task.updatedAt
    await progress(task.error,'error')
  }finally{
    runningImportTasks.delete(task.id)
  }
}

app.get('/api/services', async (_req,res)=>res.json(await readServices()))
app.get('/api/health', (_req,res)=>res.json({ok:true}))
app.get('/api/settings', async (_req,res)=>res.json(await readSettings()))
app.get('/api/bookings', async (_req, res) => res.json((await readBookings()).map(b=>({...scheduleBooking(b),type:b.type||'booking'}))))
app.get('/api/my-bookings', async (req,res)=>{ const token=req.headers['x-owner-token']; if(!token)return res.json([]);const serviceList=await readServices();res.json((await readBookings()).filter(b=>b.ownerToken===token).map(b=>({...publicBooking(b),name:b.name,phone:b.phone,note:b.note,serviceIds:b.serviceIds||b.services.map(name=>serviceList.find(s=>s.name===name)?.id).filter(Boolean)}))) })

app.post('/api/bookings', async (req, res) => {
  const { date, startTime, selectedServices, name, phone, note = '', ownerToken } = req.body
  const serviceList=await readServices(); const serviceMap=Object.fromEntries(serviceList.map(s=>[s.id,s]))
  if (!date || !startTime || !name?.trim() || !phone?.trim() || !ownerToken || !Array.isArray(selectedServices) || !selectedServices.length || selectedServices.some(id => !serviceMap[id])) return res.status(400).json({ message: '請完整填寫預約資料。' })
  const duration = selectedServices.reduce((sum, id) => sum + serviceMap[id].minutes, 0)
  const start = minutesOf(startTime), end = start + duration
  if (start < 540 || start > 1200 || end > 1320 || start % 30) return res.status(400).json({ message: '可預約開始時間為 09:00–20:00，且服務需在 22:00 前完成。' })
  const bookings = await readBookings()
  if (bookings.some(b => b.date === date && overlaps(start, end, minutesOf(b.startTime), minutesOf(b.endTime)))) return res.status(409).json({ message: '這個時段剛剛已被預約，請選擇其他時間。' })
  const endTime = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`
  const booking = { id: crypto.randomUUID(), date, startTime, endTime, services: selectedServices.map(id => serviceMap[id].name), serviceIds:selectedServices, name: name.trim(), phone: phone.trim(), note: note.trim(), ownerToken, createdAt: new Date().toISOString() }
  bookings.push(booking); await writeBookings(bookings)
  res.status(201).json(publicBooking(booking))
})

app.delete('/api/my-bookings/:id',async(req,res)=>{ const token=req.headers['x-owner-token']; const bookings=await readBookings(); const index=bookings.findIndex(b=>b.id===req.params.id&&b.ownerToken===token); if(index<0)return res.status(403).json({message:'無法取消這筆預約。'}); bookings.splice(index,1); await writeBookings(bookings); res.status(204).end() })
app.put('/api/my-bookings/:id',async(req,res)=>{const token=req.headers['x-owner-token'];const bookings=await readBookings();const index=bookings.findIndex(b=>b.id===req.params.id&&b.ownerToken===token);if(index<0)return res.status(403).json({message:'無法修改這筆預約。'});const{date,startTime,selectedServices,name,phone,note=''}=req.body;const serviceList=await readServices();const serviceMap=Object.fromEntries(serviceList.map(s=>[s.id,s]));if(!date||!startTime||!name?.trim()||!phone?.trim()||!selectedServices?.length||selectedServices.some(id=>!serviceMap[id]))return res.status(400).json({message:'請完整填寫預約資料。'});const duration=selectedServices.reduce((sum,id)=>sum+serviceMap[id].minutes,0),start=minutesOf(startTime),end=start+duration;if(start<540||start>1200||end>1320)return res.status(400).json({message:'超出可預約時間。'});if(bookings.some((b,i)=>i!==index&&b.date===date&&overlaps(start,end,minutesOf(b.startTime),minutesOf(b.endTime))))return res.status(409).json({message:'這個時段已有其他預約或休假。'});const updated={...bookings[index],date,startTime,endTime:minutesToClock(end),services:selectedServices.map(id=>serviceMap[id].name),serviceIds:selectedServices,name:name.trim(),phone:phone.trim(),note:note.trim(),updatedAt:new Date().toISOString()};bookings[index]=updated;await writeBookings(bookings);res.json(publicBooking(updated))})
app.post('/api/admin/login',(req,res)=>req.body.password===ADMIN_PASSWORD?res.json({ok:true}):res.status(401).json({message:'密碼不正確。'}))
app.get('/api/admin/bookings',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({message:'未授權'});res.json(await readBookings())})
app.post('/api/admin/bookings',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({message:'未授權'});const{date,startTime,serviceId,name,phone='',note=''}=req.body;const serviceList=await readServices();const service=serviceList.find(s=>s.id===serviceId);if(!date||!startTime||!service||!name?.trim())return res.status(400).json({message:'請完整填寫預約資料。'});const start=minutesOf(startTime),end=start+service.minutes;if(start<540||start>1200||end>1320)return res.status(400).json({message:'超出可預約時間。'});const bookings=await readBookings();if(bookings.some(b=>b.date===date&&overlaps(start,end,minutesOf(b.startTime),minutesOf(b.endTime))))return res.status(409).json({message:'這個時段已有預約或休假。'});const booking={id:crypto.randomUUID(),type:'booking',date,startTime,endTime:minutesToClock(end),services:[service.name],serviceIds:[service.id],name:name.trim(),phone:phone.trim(),note:note.trim(),ownerToken:'admin',createdAt:new Date().toISOString()};bookings.push(booking);await writeBookings(bookings);res.status(201).json(booking)})
app.post('/api/admin/leaves',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({message:'未授權'});const{date,startTime='09:00',endTime='22:00',note=''}=req.body;if(!date||minutesOf(startTime)>=minutesOf(endTime))return res.status(400).json({message:'休假時間不正確。'});const bookings=await readBookings();if(bookings.some(b=>b.date===date&&overlaps(minutesOf(startTime),minutesOf(endTime),minutesOf(b.startTime),minutesOf(b.endTime))))return res.status(409).json({message:'這段時間已有預約或休假，請先處理原有資料。'});const leave={id:crypto.randomUUID(),type:'leave',date,startTime,endTime,services:['休假'],name:'休假',phone:'',note:note.trim(),ownerToken:'admin',createdAt:new Date().toISOString()};bookings.push(leave);await writeBookings(bookings);res.status(201).json(leave)})
app.put('/api/admin/services',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({message:'未授權'});const list=req.body;if(!Array.isArray(list)||list.some(s=>!s.id||!s.name||!Number.isFinite(+s.minutes)||+s.minutes<30||!Number.isFinite(+s.price)||+s.price<0))return res.status(400).json({message:'項目資料不完整。'});await writeServices(list.map(s=>({...s,minutes:+s.minutes,price:+s.price,showPrice:s.showPrice!==false})));res.json(await readServices())})
app.put('/api/admin/settings',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({message:'未授權'});const current=await readSettings();const next={...current,announcement:String(req.body.announcement||'').trim(),googleSheetUrl:String(req.body.googleSheetUrl||'').trim()};await writeSettings(next);res.json(next)})
app.get('/api/admin/import-google/latest',async(req,res)=>{
  if(!isAdmin(req))return res.status(401).json({message:'未授權'})
  res.json(await latestImportTask())
})
app.post('/api/admin/import-google',async(req,res)=>{
  if(!isAdmin(req))return res.status(401).json({message:'未授權'})
  if(!process.env.DEEPSEEK_API_KEY)return res.status(500).json({message:'伺服器尚未設定 DeepSeek API Key。'})
  const latest=await latestImportTask()
  if(latest?.status==='running')return res.status(409).json({message:'已有同步正在執行中。',task:latest})
  const task={id:crypto.randomUUID(),status:'running',params:{url:req.body.url||'',year:Number(req.body.year)||new Date().getFullYear()},progress:[],records:[],error:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),finishedAt:''}
  await writeImportTask(task)
  runImportTask(task).catch(error=>console.error('Google import task failed',error))
  res.status(202).json(task)
})
app.post('/api/admin/confirm-import',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({message:'未授權'});const incoming=Array.isArray(req.body.records)?req.body.records:[],bookings=await readBookings();let imported=0,skipped=0;for(const raw of incoming){const record=normalizeAiRecord(raw);if(!record){skipped++;continue}const signature=`${record.date}|${record.startTime}|${record.endTime}|${record.type}|${record.note}`;if(bookings.some(b=>b.importSignature===signature||(b.date===record.date&&overlaps(minutesOf(record.startTime),minutesOf(record.endTime),minutesOf(b.startTime),minutesOf(b.endTime))))){skipped++;continue}bookings.push({...record,id:crypto.randomUUID(),importSignature:signature,ownerToken:'google-import',createdAt:new Date().toISOString()});imported++}await writeBookings(bookings);res.json({imported,skipped})})
app.get('/api/admin/export-excel',async(req,res)=>{
  if(!isAdmin(req))return res.status(401).json({message:'未授權'})
  const bookings=(await readBookings()).sort((a,b)=>`${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`))
  const workbook=new ExcelJS.Workbook()
  workbook.creator='指尖日常預約系統';workbook.created=new Date()
  const sheet=workbook.addWorksheet('預約資料',{views:[{state:'frozen',ySplit:1}]})
  sheet.columns=[
    {header:'日期',key:'date',width:14},{header:'開始時間',key:'startTime',width:12},{header:'結束時間',key:'endTime',width:12},
    {header:'類型',key:'type',width:10},{header:'服務項目',key:'services',width:28},{header:'顧客姓名',key:'name',width:16},
    {header:'聯絡電話',key:'phone',width:18},{header:'備註',key:'note',width:34},{header:'資料來源',key:'source',width:16},{header:'建立時間',key:'createdAt',width:22}
  ]
  bookings.forEach(item=>sheet.addRow({date:item.date,startTime:item.startTime,endTime:item.endTime,type:item.type==='leave'?'休假':'預約',services:(item.services||[]).join('、'),name:item.type==='leave'?'':(item.name||''),phone:item.type==='leave'?'':(item.phone||''),note:item.note||'',source:item.source==='google-sheet'?'Google 預約表':'網站預約',createdAt:item.createdAt?new Date(item.createdAt):''}))
  const header=sheet.getRow(1);header.height=26;header.font={bold:true,color:{argb:'FFFFFFFF'}};header.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF74836A'}};header.alignment={vertical:'middle'}
  sheet.autoFilter={from:'A1',to:'J1'}
  sheet.getColumn('date').numFmt='yyyy-mm-dd';sheet.getColumn('createdAt').numFmt='yyyy-mm-dd hh:mm'
  sheet.eachRow((row,index)=>{if(index>1){row.alignment={vertical:'top',wrapText:true};if(index%2===0)row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF4F7F1'}}}})
  const buffer=await workbook.xlsx.writeBuffer(),stamp=new Date().toISOString().slice(0,10)
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(`預約資料-${stamp}.xlsx`)}`)
  res.send(Buffer.from(buffer))
})
app.delete('/api/admin/bookings/:id',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({message:'未授權'});const bookings=await readBookings();const next=bookings.filter(b=>b.id!==req.params.id);if(next.length===bookings.length)return res.status(404).json({message:'找不到預約'});await writeBookings(next);res.status(204).end()})

app.use(express.static(path.join(__dirname, '../dist')))
app.use((_req, res) => res.sendFile(path.join(__dirname, '../dist/index.html')))
app.listen(PORT, () => console.log(`API running at http://localhost:${PORT}`))
