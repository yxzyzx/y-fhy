<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'

const serviceOptions = ref([])
const bookings = ref([]), myBookings = ref([]), loading = ref(true), message = ref(''), submitting = ref(false), offlineData=ref(false), adminOfflineData=ref(false)
const settings=reactive({announcement:'',googleSheetUrl:''})
const defaultServices=[
  {id:'hands',name:'手部美甲',caption:'',minutes:120,price:1200,showPrice:false},
  {id:'feet',name:'足部美甲',caption:'',minutes:120,price:1500,showPrice:false},
  {id:'removal',name:'卸甲',caption:'',minutes:30,price:500,showPrice:false}
]
const ownerToken = localStorage.getItem('nailOwnerToken') || crypto.randomUUID(); localStorage.setItem('nailOwnerToken', ownerToken)
const adminMode=ref(location.pathname==='/admin'||location.pathname==='/admin/'),adminLoggedIn=ref(false),adminPassword=ref(''),adminMessage=ref(''),adminBookings=ref([]),adminServices=ref([])
const adminCreate=reactive({open:false,mode:'booking',date:'',startTime:'09:00',endTime:'22:00',wholeDay:true,serviceId:'',name:'',email:'',note:''})
const importYear=ref(new Date().getFullYear()),importing=ref(false),confirmingImport=ref(false),importMessage=ref(''),importPreview=ref([]),importOpen=ref(false),importProgress=ref([]),importTask=ref(null),importPoller=ref(null)
const importSetupOpen=ref(false),exportConfirmOpen=ref(false)
const adminDetail=ref(null)
const editMy=reactive({open:false,id:'',date:'',startTime:'',selectedServices:[],name:'',email:'',note:'',message:''})
const form = reactive({ selectedServices: ['hands'], date: '', startTime: '', name: '', email: '', note: '' })
const contactStorageKey = 'nailBookingContact'
const today = new Date(); today.setHours(0, 0, 0, 0)
const toKey = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
const addDays = (d, n) => { const next = new Date(d); next.setDate(next.getDate()+n); return next }
const weekdays = ['日','一','二','三','四','五','六']
const monthCursor = ref(new Date(today.getFullYear(),today.getMonth(),1))
const days = computed(() => {
  const year=monthCursor.value.getFullYear(),month=monthCursor.value.getMonth(),count=new Date(year,month+1,0).getDate()
  const monthDays=Array.from({length:count},(_,i)=>new Date(year,month,i+1))
  return adminMode.value ? monthDays : monthDays.filter(day=>day>=today)
})
const hours = Array.from({ length: 13 }, (_, i) => 9 + i)
const scheduleStartMinutes = 9 * 60
const scheduleEndMinutes = 22 * 60
const slotMinutes = 30
const duration = computed(() => form.selectedServices.reduce((sum, id) => sum + (serviceOptions.value.find(s => s.id === id)?.minutes||0), 0))
const pricedSelections = computed(() => form.selectedServices.map(id=>serviceOptions.value.find(s=>s.id===id)).filter(s=>s && s.showPrice!==false))
const estimatedPrice = computed(() => pricedSelections.value.reduce((sum,s)=>sum+(s.price||0),0))
const showEstimatedPrice = computed(() => pricedSelections.value.length > 0)
const announcementItems=computed(()=>settings.announcement.split(/\n+/).map(item=>item.trim()).filter(Boolean))
const timeToMinutes = t => { const [h,m]=t.split(':').map(Number); return h*60+m }
const minutesToTime = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`
const endTime = computed(() => form.startTime ? minutesToTime(timeToMinutes(form.startTime)+duration.value) : '—')
const bookingFor = (date, hour) => bookings.value.find(b => b.date === toKey(date) && timeToMinutes(b.startTime) <= hour*60 && timeToMinutes(b.endTime) > hour*60)
const adminBookingFor = (date,hour) => adminBookings.value.find(b=>b.date===toKey(date)&&timeToMinutes(b.startTime)<=hour*60&&timeToMinutes(b.endTime)>hour*60)
const isStart = (b, hour) => b && timeToMinutes(b.startTime) === hour*60
const bookingAt = (dateKey, start, list) => list.find(b => b.date === dateKey && timeToMinutes(b.startTime) < start + slotMinutes && timeToMinutes(b.endTime) > start)
const scheduleCells = (date, list) => {
  const dateKey = toKey(date)
  const cells = []
  let cursor = scheduleStartMinutes
  while (cursor < scheduleEndMinutes) {
    const booking = bookingAt(dateKey, cursor, list)
    if (booking) {
      const end = Math.min(scheduleEndMinutes, timeToMinutes(booking.endTime))
      const span = Math.max(1, Math.ceil((end - cursor) / slotMinutes))
      cells.push({ key: `${dateKey}-${booking.id}-${cursor}`, type: 'booked', booking, start: cursor, span })
      cursor += span * slotMinutes
    } else {
      cells.push({ key: `${dateKey}-empty-${cursor}`, type: 'available', start: cursor, span: 1 })
      cursor += slotMinutes
    }
  }
  return cells
}
const availableTimes = computed(() => {
  if (!form.date || !duration.value) return []
  const result=[]
  for(let start=540; start<=1200 && start+duration.value<=1320; start+=30){
    const conflict=bookings.value.some(b=>b.date===form.date && start<timeToMinutes(b.endTime) && timeToMinutes(b.startTime)<start+duration.value)
    if(!conflict) result.push(minutesToTime(start))
  }
  return result
})
const editDuration=computed(()=>editMy.selectedServices.reduce((sum,id)=>sum+(serviceOptions.value.find(s=>s.id===id)?.minutes||0),0))
const editAvailableTimes=computed(()=>{if(!editMy.date||!editDuration.value)return[];const result=[];for(let start=540;start<=1200&&start+editDuration.value<=1320;start+=30){if(!bookings.value.some(b=>b.id!==editMy.id&&b.date===editMy.date&&start<timeToMinutes(b.endTime)&&timeToMinutes(b.startTime)<start+editDuration.value))result.push(minutesToTime(start))}return result})
const monthLabel = computed(() => `${monthCursor.value.getFullYear()}年 ${monthCursor.value.getMonth()+1}月`)
const canMovePrevious = computed(() => adminMode.value || monthCursor.value > new Date(today.getFullYear(),today.getMonth(),1))
const totalBooked = computed(() => bookings.value.filter(b=>days.value.some(d=>toKey(d)===b.date)).length)

watch([() => form.date, duration], () => { if (!availableTimes.value.includes(form.startTime)) form.startTime = availableTimes.value[0] || '' })
watch([() => form.name, () => form.email], ([name,email]) => {
  if(name||email) localStorage.setItem(contactStorageKey,JSON.stringify({name,email}))
})
function toggleService(id){ const i=form.selectedServices.indexOf(id); if(i>=0 && form.selectedServices.length>1) form.selectedServices.splice(i,1); else if(i<0) form.selectedServices.push(id) }
function selectDate(date){ form.date=toKey(date); document.querySelector('#booking-panel')?.scrollIntoView({behavior:'smooth',block:'start'}) }
async function selectSlot(date,startMinutes){ const chosen=minutesToTime(startMinutes); form.date=toKey(date); await nextTick(); form.startTime=availableTimes.value.includes(chosen)?chosen:(availableTimes.value[0]||''); document.querySelector('#booking-panel')?.scrollIntoView({behavior:'smooth',block:'start'}) }
function moveMonth(amount){if(amount<0&&!canMovePrevious.value)return;monthCursor.value=new Date(monthCursor.value.getFullYear(),monthCursor.value.getMonth()+amount,1)}
async function fetchJson(url){const res=await fetch(url);if(!res.ok)throw new Error(`${url} ${res.status}`);return res.json()}
async function loadBookings(){loading.value=true;try{const res=await fetch('/api/bookings');if(!res.ok)throw new Error();bookings.value=await res.json();localStorage.setItem('nailBookingsBackup',JSON.stringify(bookings.value));offlineData.value=false}catch{const backup=localStorage.getItem('nailBookingsBackup');bookings.value=backup?JSON.parse(backup):[];offlineData.value=!!backup}finally{loading.value=false}}
async function loadMine(){let list=[];try{const res=await fetch('/api/my-bookings',{headers:{'x-owner-token':ownerToken}});if(!res.ok)throw new Error();list=await res.json();localStorage.setItem('nailMyBookingsBackup',JSON.stringify(list))}catch{const backup=localStorage.getItem('nailMyBookingsBackup');list=backup?JSON.parse(backup):[]}myBookings.value=list.filter(b=>new Date(`${b.date}T${b.endTime}:00`) > new Date()).sort((a,b)=>`${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`))}
async function cancelMine(id){ if(!confirm('確定要取消這筆預約嗎？'))return; const res=await fetch(`/api/my-bookings/${id}`,{method:'DELETE',headers:{'x-owner-token':ownerToken}}); if(res.ok){await Promise.all([loadMine(),loadBookings()])} }
function openEditMine(booking){Object.assign(editMy,{open:true,id:booking.id,date:booking.date,startTime:booking.startTime,selectedServices:[...(booking.serviceIds||[])],name:booking.name||'',email:booking.email||booking.phone||'',note:booking.note||'',message:''})}
function toggleEditService(id){const i=editMy.selectedServices.indexOf(id);if(i>=0&&editMy.selectedServices.length>1)editMy.selectedServices.splice(i,1);else if(i<0)editMy.selectedServices.push(id)}
async function saveMine(){editMy.message='';const res=await fetch(`/api/my-bookings/${editMy.id}`,{method:'PUT',headers:{'Content-Type':'application/json','x-owner-token':ownerToken},body:JSON.stringify({...editMy,phone:editMy.email})});const body=await res.json();if(!res.ok){editMy.message=body.message;return}editMy.open=false;await Promise.all([loadMine(),loadBookings()])}
async function submit(){
  message.value=''; submitting.value=true
  try{
    const res=await fetch('/api/bookings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...form,phone:form.email,ownerToken})})
    const body=await res.json(); if(!res.ok) throw new Error(body.message)
    bookings.value.push(body); myBookings.value.push(body); message.value=`預約成功！已為妳保留 ${form.date} ${form.startTime}–${body.endTime}。`
    form.note=''; form.startTime=''
  }catch(error){ message.value=error.message } finally{submitting.value=false}
}
async function adminLogin(){adminMessage.value='';try{const res=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:adminPassword.value})});if(!res.ok){adminMessage.value='密碼不正確。';localStorage.removeItem('nailAdminPassword');return}localStorage.setItem('nailAdminPassword',adminPassword.value);adminLoggedIn.value=true;await loadAdmin();await loadImportTask()}catch{if(localStorage.getItem('nailAdminBackup')&&localStorage.getItem('nailAdminPassword')===adminPassword.value){adminLoggedIn.value=true;await loadAdmin()}else adminMessage.value='目前無法連線，也沒有可用的本地備份。'}}
async function loadAdmin(){const h={'x-admin-password':adminPassword.value};try{const [settingsRes,bookingsRes,servicesRes]=await Promise.all([fetch('/api/settings'),fetch('/api/admin/bookings',{headers:h}),fetch('/api/services')]);if(!settingsRes.ok||!bookingsRes.ok||!servicesRes.ok)throw new Error();const [loadedSettings,loadedBookings,loadedServices]=await Promise.all([settingsRes.json(),bookingsRes.json(),servicesRes.json()]);Object.assign(settings,loadedSettings);adminBookings.value=loadedBookings;adminServices.value=loadedServices;localStorage.setItem('nailAdminBackup',JSON.stringify({settings:loadedSettings,bookings:loadedBookings,services:loadedServices,savedAt:new Date().toISOString()}));adminOfflineData.value=false}catch{const backup=localStorage.getItem('nailAdminBackup');if(!backup)throw new Error('目前無法連線，也沒有可用的本地備份。');const cached=JSON.parse(backup);Object.assign(settings,cached.settings||{});adminBookings.value=cached.bookings||[];adminServices.value=cached.services||[];adminOfflineData.value=true}}
async function downloadExcel(silent=false){try{const res=await fetch('/api/admin/export-excel',{headers:{'x-admin-password':adminPassword.value}});if(!res.ok)throw new Error('Excel 匯出失敗。');const blob=await res.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`預約資料-${new Date().toISOString().slice(0,10)}.xlsx`;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);exportConfirmOpen.value=false;if(!silent)adminMessage.value='Excel 已下載。'}catch(error){if(!silent)adminMessage.value=error.message}}
function addService(){adminServices.value.push({id:crypto.randomUUID(),name:'',caption:'',minutes:60,price:0,showPrice:true})}
async function saveServices(){const res=await fetch('/api/admin/services',{method:'PUT',headers:{'Content-Type':'application/json','x-admin-password':adminPassword.value},body:JSON.stringify(adminServices.value)});const body=await res.json();if(!res.ok){adminMessage.value=body.message;return}serviceOptions.value=body;adminServices.value=structuredClone(body);adminMessage.value='項目設定已儲存。'}
async function adminDeleteBooking(id){if(!confirm('確定刪除這筆預約嗎？'))return;await fetch(`/api/admin/bookings/${id}`,{method:'DELETE',headers:{'x-admin-password':adminPassword.value}});adminDetail.value=null;await Promise.all([loadAdmin(),loadBookings(),loadMine()])}
function adminCellClick(day,cell){if(cell.booking){adminDetail.value=cell.booking;return}Object.assign(adminCreate,{open:true,mode:'booking',date:toKey(day),startTime:minutesToTime(cell.start),endTime:'22:00',wholeDay:true,serviceId:adminServices.value[0]?.id||'',name:'',email:'',note:''})}
async function adminAddBooking(){adminMessage.value='';const endpoint=adminCreate.mode==='leave'?'/api/admin/leaves':'/api/admin/bookings';const payload=adminCreate.mode==='leave'?{date:adminCreate.date,startTime:adminCreate.wholeDay?'09:00':adminCreate.startTime,endTime:adminCreate.wholeDay?'22:00':adminCreate.endTime,note:adminCreate.note}:{...adminCreate,phone:adminCreate.email};const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','x-admin-password':adminPassword.value},body:JSON.stringify(payload)});const body=await res.json();if(!res.ok){adminMessage.value=body.message;return}adminCreate.open=false;await Promise.all([loadAdmin(),loadBookings()])}
async function saveSettings(){adminMessage.value='';const res=await fetch('/api/admin/settings',{method:'PUT',headers:{'Content-Type':'application/json','x-admin-password':adminPassword.value},body:JSON.stringify(settings)});const body=await res.json();if(!res.ok){adminMessage.value=body.message;return false}Object.assign(settings,body);adminMessage.value='公告已儲存。';return true}
function pushImportProgress(message,status='working'){importProgress.value.push({id:crypto.randomUUID(),message,status,time:new Date().toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',second:'2-digit'})})}
function applyImportTask(task){
  importTask.value=task
  importProgress.value=task?.progress||[]
  importing.value=task?.status==='running'
  if(task?.records?.length)importPreview.value=task.records.map(record=>({...record,selected:record.status==='ready'}))
}
async function loadImportTask(){
  if(!adminLoggedIn.value)return
  const res=await fetch('/api/admin/import-google/latest',{headers:{'x-admin-password':adminPassword.value}})
  if(!res.ok)return
  const task=await res.json()
  applyImportTask(task)
  if(task?.status==='running')startImportPolling();else stopImportPolling()
}
function startImportPolling(){
  stopImportPolling()
  importPoller.value=setInterval(loadImportTask,2500)
}
function stopImportPolling(){if(importPoller.value){clearInterval(importPoller.value);importPoller.value=null}}
async function importGoogle(){
  importing.value=true;importMessage.value='';importProgress.value=[];pushImportProgress('準備建立後台同步任務…')
  try{
    const res=await fetch('/api/admin/import-google',{method:'POST',headers:{'Content-Type':'application/json','x-admin-password':adminPassword.value},body:JSON.stringify({url:settings.googleSheetUrl,year:importYear.value})})
    const body=await res.json();if(!res.ok&&!body.task)throw new Error(body.message)
    applyImportTask(body.task||body)
    importMessage.value=res.ok?'已建立後台同步任務，可以離開這個頁面。':body.message
    startImportPolling()
  }catch(error){importMessage.value=error.message;pushImportProgress(error.message,'error');importing.value=false}
}
async function confirmGoogleImport(){const selected=importPreview.value.filter(r=>r.selected&&r.status==='ready');if(!selected.length){importMessage.value='沒有選擇可匯入的資料。';return}confirmingImport.value=true;try{const res=await fetch('/api/admin/confirm-import',{method:'POST',headers:{'Content-Type':'application/json','x-admin-password':adminPassword.value},body:JSON.stringify({records:selected})});const body=await res.json();if(!res.ok)throw new Error(body.message);importOpen.value=false;importMessage.value=`已匯入 ${body.imported} 筆${body.skipped?`，另有 ${body.skipped} 筆因最新衝突而跳過`:''}。`;await Promise.all([loadAdmin(),loadBookings()])}catch(error){importMessage.value=error.message}finally{confirmingImport.value=false}}
function closeAdmin(){location.href='/'}
function openImportResult(){if(importTask.value?.records?.length){importPreview.value=importTask.value.records.map(record=>({...record,selected:record.status==='ready'}));importOpen.value=true}}
onMounted(async()=>{
  const savedContact=localStorage.getItem(contactStorageKey)
  if(savedContact){try{const contact=JSON.parse(savedContact);form.name=contact.name||'';form.email=contact.email||contact.phone||''}catch{localStorage.removeItem(contactStorageKey)}}
  form.date=toKey(today)
  serviceOptions.value=defaultServices
  form.selectedServices=[serviceOptions.value[0]?.id].filter(Boolean)
  const bookingLoads=Promise.allSettled([loadBookings(),loadMine()])
  const setupLoad=(async()=>{
    const [servicesData,settingsData]=await Promise.all([fetchJson('/api/services'),fetchJson('/api/settings')])
    if(Array.isArray(servicesData)&&servicesData.length){
      serviceOptions.value=servicesData
      if(!form.selectedServices.every(id=>serviceOptions.value.some(service=>service.id===id)))form.selectedServices=[serviceOptions.value[0]?.id].filter(Boolean)
    }
    Object.assign(settings,settingsData)
  })().catch(()=>{
    offlineData.value=true
  })
  await Promise.allSettled([bookingLoads,setupLoad])
  if(adminMode.value){const saved=localStorage.getItem('nailAdminPassword');if(saved){adminPassword.value=saved;await adminLogin()}}
})
</script>

<template>
  <div v-if="!adminMode">
  <div v-if="announcementItems.length" class="announcement-bar" role="status"><span class="announcement-pin">●</span><div class="announcement-window"><div class="announcement-track"><span v-for="(item,index) in [...announcementItems,...announcementItems]" :key="index">{{ item }}</span></div></div></div>
  <header class="topbar"><div class="brand"><span class="brand-mark">指尖日常</span><span>為妳留一段專屬的慢時光</span></div><button class="primary compact" @click="selectDate(today)">預約時段 <span>↘</span></button></header>
  <main>
    <section class="hero"><div><h1>選一段時間，<br><em>好好照顧自己。</em></h1></div></section>
    <div class="content-stack">
      <section v-if="myBookings.length" class="my-bookings">
        <div><h2>已有預約</h2></div>
        <div class="my-booking-list"><article v-for="booking in myBookings" :key="booking.id"><div><b>{{ booking.date }}</b><strong>{{ booking.startTime }}–{{ booking.endTime }}</strong><span>{{ booking.services.join('・') }}</span></div><span class="my-actions"><button @click="openEditMine(booking)">修改預約</button><button @click="cancelMine(booking.id)">取消預約</button></span></article></div>
      </section>
      <aside id="booking-panel" class="booking-card">
        <div class="booking-intro"><h2>預約妳的時段</h2><p class="muted">可複選服務，預估時間會自動加總。</p></div>
        <form @submit.prevent="submit">
          <fieldset><legend>01 選擇服務</legend><div class="service-grid"><button v-for="service in serviceOptions" :key="service.id" type="button" class="service" :class="{active:form.selectedServices.includes(service.id)}" :aria-pressed="form.selectedServices.includes(service.id)" @click="toggleService(service.id)"><span class="check" aria-hidden="true"><span v-if="form.selectedServices.includes(service.id)">✓</span></span><span><b>{{ service.name }}</b><small v-if="service.caption">{{ service.caption }}</small></span><strong>估計 {{ service.minutes/60 }} 小時<template v-if="service.showPrice!==false"><br>{{ service.price.toLocaleString('zh-TW') }} 元</template></strong></button></div></fieldset>
          <div class="booking-fields"><label>02 預約日期<input v-model="form.date" type="date" :min="toKey(today)" required></label><label>03 開始時間<select v-model="form.startTime" required><option value="" disabled>請選擇</option><option v-for="time in availableTimes" :key="time">{{ time }}</option></select></label><label>姓名<input v-model="form.name" maxlength="30" required></label><label>聯絡信箱<input v-model="form.email" type="email" maxlength="80" required></label></div>
          <div class="booking-bottom"><div class="time-summary vertical"><span>預估時間 <b>約 {{ duration/60 }} 小時</b></span><span v-if="showEstimatedPrice">預估價格 <b>約 {{ estimatedPrice.toLocaleString('zh-TW') }} 元</b></span><span>預約時段 <b>{{ form.startTime || '—' }} <i>→</i> {{ endTime }}</b></span></div><label class="note-field">備註（選填）<input v-model="form.note" placeholder="想做的款式、卸甲狀況或其他需求"></label><button class="primary submit" :disabled="submitting || !availableTimes.length">{{ submitting?'預約送出中…':'確認預約' }} <span>→</span></button></div>
          <p v-if="message" class="message" role="status">{{ message }}</p><p class="fine-print">送出後即為預約成立。如需更改，請提前與我們聯絡。</p>
        </form>
      </aside>
      <section class="schedule-card">
        <div class="section-head"><div class="schedule-title"><h2>預約表</h2><span v-if="offlineData" class="offline-badge">離線資料</span></div><div class="week-nav"><button :disabled="!canMovePrevious" @click="moveMonth(-1)" aria-label="上個月">←</button><span>{{ monthLabel }}</span><button @click="moveMonth(1)" aria-label="下個月">→</button></div></div>
        <div class="table-wrap" :class="{loading}">
          <div v-if="loading" class="schedule-loading">預約表載入中…</div>
          <div class="schedule-table transposed">
            <div class="corner">日期</div><div v-for="hour in hours" :key="hour" class="time-head">{{ String(hour).padStart(2,'0') }}:00</div>
            <template v-for="day in days" :key="toKey(day)">
              <button class="date-row-head" :class="{today:toKey(day)===toKey(today),selected:form.date===toKey(day)}" @click="selectDate(day)"><b>週{{ weekdays[day.getDay()] }}</b><span>{{ day.getMonth()+1 }}/{{ day.getDate() }}</span></button>
              <button v-for="cell in scheduleCells(day,bookings)" :key="cell.key" class="slot merged-slot" :class="cell.booking?'booked':'available'" :style="{gridColumn:`span ${cell.span}`}" :disabled="!!cell.booking" @click="selectSlot(day,cell.start)">
                <template v-if="cell.booking"><span class="booking-text public-booking-text"><b>{{ cell.booking.type==='leave'?'休假':'已約' }}</b></span></template>
                <span v-else>{{ minutesToTime(cell.start) }}</span>
              </button>
            </template>
          </div>
        </div>
        <div class="legend"><span><i class="sage"></i>可預約</span><span><i class="rose"></i>已預約／休假</span><span><i class="clay"></i>選取日期</span></div>
      </section>
    </div>
  </main>
  <footer>
    <section class="line-contact" aria-label="LINE 聯絡方式">
      <p>LINE 聯絡方式</p>
      <img src="/line-contact.jpg" alt="LINE 聯絡方式 QR Code">
    </section>
    <a href="/admin">後台管理</a>
  </footer>
  <div v-if="editMy.open" class="admin-overlay"><form class="admin-create-card" @submit.prevent="saveMine"><button type="button" class="admin-close" @click="editMy.open=false">×</button><h2>修改預約</h2><div class="edit-services"><button v-for="service in serviceOptions" :key="service.id" type="button" :class="{active:editMy.selectedServices.includes(service.id)}" @click="toggleEditService(service.id)">{{ service.name }}</button></div><div class="two"><label>日期<input v-model="editMy.date" type="date" :min="toKey(today)" required></label><label>開始時間<select v-model="editMy.startTime" required><option v-for="time in editAvailableTimes" :key="time">{{ time }}</option></select></label></div><div class="two"><label>姓名<input v-model="editMy.name" required></label><label>聯絡信箱<input v-model="editMy.email" type="email" required></label></div><label>備註<input v-model="editMy.note"></label><p v-if="editMy.message" class="message">{{ editMy.message }}</p><button class="primary">儲存修改</button></form></div>
  </div>
  <div v-else class="admin-page">
    <header class="admin-topbar"><div><button class="brand-mark brand-home" type="button" @click="closeAdmin">指尖日常</button><span class="admin-label">後台管理</span></div><div class="admin-nav-actions"><template v-if="adminLoggedIn"><button class="nav-icon-button" title="從 Google 預約表中匯入" aria-label="從 Google 預約表中匯入" @click="importMessage='';importSetupOpen=true"><span aria-hidden="true">⇩</span></button><button class="nav-icon-button" title="匯出為 Excel" aria-label="匯出為 Excel" @click="exportConfirmOpen=true"><span aria-hidden="true">⇧</span></button></template></div></header>
    <main class="admin-main">
      <section v-if="!adminLoggedIn" class="admin-login-card"><h1>後台登入</h1><p>請輸入管理密碼以繼續。</p><form class="admin-login" @submit.prevent="adminLogin"><label>管理密碼<input v-model="adminPassword" type="password" autofocus required></label><button class="primary">登入後台</button></form><p v-if="adminMessage" class="message">{{ adminMessage }}</p></section>
      <template v-else>
        <div class="admin-heading"><div><div class="admin-heading-title"><h1>後台管理</h1><span v-if="adminOfflineData" class="offline-badge">離線資料</span></div><p>點選空白時段新增預約；點選已有預約即可取消。</p></div></div>
        <section v-if="importTask" class="import-status-panel">
          <div class="admin-title"><div><h2>上一次 Google 同步</h2><p>{{ importTask.status==='running'?'同步進行中':importTask.status==='done'?'同步已完成':'同步失敗' }}<template v-if="importTask.updatedAt"> ・ {{ new Date(importTask.updatedAt).toLocaleString('zh-TW') }}</template></p></div><button v-if="importTask.status==='done'&&importTask.records?.length" @click="openImportResult">查看辨識結果</button></div>
          <div v-if="importProgress.length" class="import-progress compact-progress" aria-live="polite"><div v-for="item in importProgress" :key="item.id" class="import-progress-item" :class="item.status"><span>{{ item.time }}</span><b>{{ item.message }}</b></div></div>
        </section>
        <section class="admin-panel standalone">
          <div class="admin-section first admin-settings"><div class="admin-title"><h2>公告</h2></div><label>前台公告<textarea v-model="settings.announcement" rows="3"></textarea></label><button class="primary save-settings" @click="saveSettings">儲存公告</button><p v-if="adminMessage" class="message">{{ adminMessage }}</p></div>
          <div class="admin-section"><div class="admin-title"><h2>服務項目</h2><button @click="addService">＋ 新增項目</button></div><div class="admin-service" v-for="(service,index) in adminServices" :key="service.id"><input v-model="service.name" placeholder="項目名稱"><input v-model="service.caption" placeholder="項目說明"><label>分鐘<input v-model.number="service.minutes" type="number" min="30" step="30"></label><label>預估價格<input v-model.number="service.price" type="number" min="0" step="100"></label><label class="price-toggle"><input v-model="service.showPrice" type="checkbox"><span>顯示價格</span></label><button class="danger" @click="adminServices.splice(index,1)">刪除</button></div><button class="primary save-settings" @click="saveServices">儲存項目設定</button><p v-if="adminMessage" class="message">{{ adminMessage }}</p></div>
          <div class="admin-section admin-schedule-section"><div class="section-head admin-schedule-head"><h2>預約表</h2><div class="week-nav"><button @click="moveMonth(-1)" aria-label="上個月">←</button><span>{{ monthLabel }}</span><button @click="moveMonth(1)" aria-label="下個月">→</button></div></div><div class="table-wrap"><div class="schedule-table transposed admin-schedule"><div class="corner">日期</div><div v-for="hour in hours" :key="hour" class="time-head">{{ String(hour).padStart(2,'0') }}:00</div><template v-for="day in days" :key="toKey(day)"><div class="date-row-head"><b>週{{ weekdays[day.getDay()] }}</b><span>{{ day.getMonth()+1 }}/{{ day.getDate() }}</span></div><button v-for="cell in scheduleCells(day,adminBookings)" :key="cell.key" class="slot merged-slot" :class="cell.booking?'booked':'available'" :style="{gridColumn:`span ${cell.span}`}" @click="adminCellClick(day,cell)"><template v-if="cell.booking"><span class="booking-text"><b>{{ cell.booking.type==='leave'?'休假':cell.booking.name }}</b><small>{{ cell.booking.type==='leave'?(cell.booking.note||'不開放預約'):cell.booking.services.join('・') }}　{{ cell.booking.startTime }}–{{ cell.booking.endTime }}</small></span></template><span v-else>＋</span></button></template></div></div></div>
        </section>
        <div v-if="adminCreate.open" class="admin-overlay"><form class="admin-create-card" @submit.prevent="adminAddBooking"><button type="button" class="admin-close" @click="adminCreate.open=false">×</button><h2>新增時段</h2><div class="mode-switch"><button type="button" :class="{active:adminCreate.mode==='booking'}" @click="adminCreate.mode='booking'">新增預約</button><button type="button" :class="{active:adminCreate.mode==='leave'}" @click="adminCreate.mode='leave'">設定休假</button></div><label>日期<input v-model="adminCreate.date" type="date" required></label><template v-if="adminCreate.mode==='booking'"><label>開始時間<input v-model="adminCreate.startTime" type="time" min="09:00" max="20:00" step="1800" required></label><label>服務項目<select v-model="adminCreate.serviceId" required><option v-for="service in adminServices" :key="service.id" :value="service.id">{{ service.name }}・{{ service.minutes }} 分鐘</option></select></label><div class="two"><label>顧客姓名<input v-model="adminCreate.name" required></label><label>聯絡信箱<input v-model="adminCreate.email" type="email"></label></div></template><template v-else><label class="price-toggle"><input v-model="adminCreate.wholeDay" type="checkbox"><span>休一整天（09:00–22:00）</span></label><div v-if="!adminCreate.wholeDay" class="two"><label>開始時間<input v-model="adminCreate.startTime" type="time" min="09:00" max="21:30" step="1800"></label><label>結束時間<input v-model="adminCreate.endTime" type="time" min="09:30" max="22:00" step="1800"></label></div></template><label>備註<input v-model="adminCreate.note" :placeholder="adminCreate.mode==='leave'?'例如：休假、下午有事':''"></label><p v-if="adminMessage" class="message">{{ adminMessage }}</p><button class="primary">{{ adminCreate.mode==='leave'?'儲存休假':'新增預約' }}</button></form></div>
        <div v-if="adminDetail" class="admin-overlay"><section class="admin-detail-card"><button class="admin-close" @click="adminDetail=null">×</button><h2>{{ adminDetail.type==='leave'?'休假詳情':'預約詳情' }}</h2><dl><div><dt>日期</dt><dd>{{ adminDetail.date }}</dd></div><div><dt>時間</dt><dd>{{ adminDetail.startTime }}–{{ adminDetail.endTime }}</dd></div><template v-if="adminDetail.type!=='leave'"><div><dt>服務項目</dt><dd>{{ adminDetail.services.join('、') }}</dd></div><div><dt>顧客姓名</dt><dd>{{ adminDetail.name }}</dd></div><div><dt>聯絡信箱</dt><dd>{{ adminDetail.email || adminDetail.phone || '未填寫' }}</dd></div></template><div><dt>備註</dt><dd>{{ adminDetail.note || '無' }}</dd></div></dl><button class="delete-booking-button" @click="adminDeleteBooking(adminDetail.id)">刪除這筆{{ adminDetail.type==='leave'?'休假':'預約' }}</button></section></div>
        <div v-if="importSetupOpen" class="admin-overlay"><section class="tool-dialog"><button type="button" class="admin-close" @click="importSetupOpen=false">×</button><div class="tool-dialog-icon" aria-hidden="true">⇩</div><h2>從 Google 預約表中匯入</h2><p class="muted">建立任務後會在後台執行，下次進入後台仍可看到進度。</p><label>資料年份<input v-model.number="importYear" type="number" min="2020" max="2100" :disabled="importing"></label><div v-if="importProgress.length" class="import-progress" aria-live="polite"><div v-for="item in importProgress" :key="item.id" class="import-progress-item" :class="item.status"><span>{{ item.time }}</span><b>{{ item.message }}</b></div></div><p v-if="importMessage" class="message">{{ importMessage }}</p><div class="dialog-actions"><button type="button" @click="importSetupOpen=false">關閉</button><button type="button" v-if="importTask?.status==='done'&&importTask.records?.length" @click="openImportResult">查看結果</button><button type="button" class="primary" :disabled="importing" @click="importGoogle">{{ importing?'同步中…':'開始同步' }}</button></div></section></div>
        <div v-if="exportConfirmOpen" class="admin-overlay"><section class="tool-dialog"><button class="admin-close" @click="exportConfirmOpen=false">×</button><div class="tool-dialog-icon" aria-hidden="true">⇧</div><h2>匯出為 Excel</h2><p class="muted">將目前所有預約與休假資料下載為 Excel 檔案。</p><div class="dialog-actions"><button @click="exportConfirmOpen=false">取消</button><button class="primary" @click="downloadExcel(false)">確認匯出</button></div></section></div>
        <div v-if="importOpen" class="admin-overlay"><section class="import-preview-card"><button class="admin-close" @click="importOpen=false">×</button><h2>確認 Google 匯入資料</h2><p class="muted">衝突資料已優先排列。請確認勾選內容後再匯入。</p><div class="import-summary"><span class="conflict">衝突 {{ importPreview.filter(r=>r.status==='conflict').length }}</span><span>可匯入 {{ importPreview.filter(r=>r.status==='ready').length }}</span><span>重複 {{ importPreview.filter(r=>r.status==='duplicate').length }}</span></div><div class="import-list"><label v-for="record in importPreview" :key="record.tempId" class="import-item" :class="record.status"><input v-model="record.selected" type="checkbox" :disabled="record.status!=='ready'"><span class="import-status">{{ record.status==='conflict'?'有衝突':record.status==='duplicate'?'已存在':'可匯入' }}</span><b>{{ record.date }}　{{ record.startTime }}–{{ record.endTime }}</b><span>{{ record.type==='leave'?'休假':(record.services.join('、')||'未識別項目') }}</span><small>{{ record.note }}</small></label></div><div class="import-actions"><button @click="importOpen=false">取消</button><button class="primary" :disabled="confirmingImport||!importPreview.some(r=>r.selected&&r.status==='ready')" @click="confirmGoogleImport">{{ confirmingImport?'匯入中…':`確認匯入 ${importPreview.filter(r=>r.selected&&r.status==='ready').length} 筆` }}</button></div></section></div>
      </template>
    </main>
  </div>
</template>
