/*
 * What a counselor says and sends, in English, Hindi, Marathi and Hinglish: the call script for
 * the teleprompter, a rebuttal for each common objection, and the WhatsApp messages. {name},
 * {segment}, {me}, {link}, {price} and {until} are filled in per contact (see fillSales).
 */

export type Lang = 'en' | 'hi' | 'mr' | 'hinglish';

/** What we offer, said in every message and script in place of {segment} / [Segment] — never a list's name. */
export const OFFER = 'internship';

export const LANGS: { key: Lang; label: string; speech: string }[] = [
  { key: 'en', label: 'EN', speech: 'en-IN' },
  { key: 'hi', label: 'HI', speech: 'hi-IN' },
  { key: 'mr', label: 'MR', speech: 'mr-IN' },
  { key: 'hinglish', label: 'Hinglish', speech: 'en-IN' },
];

export interface ScriptStep { title: string; text: string }

export const SCRIPTS: { [l in Lang]: ScriptStep[] } = {
  en: [
    { title: 'Open', text: 'Hi {name}, this is {me} from Internship Studio. You had enquired about {segment} — is this a good time for two minutes?' },
    { title: 'Discover', text: 'What made you look at {segment}? Is it for a job, a college credit, or to build a skill? When would you like to start?' },
    { title: 'Pitch', text: 'Most students like you finish it in 4–6 weeks, with live mentor sessions, real projects and a certificate recruiters recognise.' },
    { title: 'Close', text: 'Shall I send you the details on WhatsApp right now and hold today’s price for you while you check?' },
  ],
  hi: [
    { title: 'शुरुआत', text: 'नमस्ते {name}, मैं Internship Studio से {me} बोल रहा/रही हूँ। आपने {segment} के बारे में पूछा था — क्या अभी दो मिनट बात हो सकती है?' },
    { title: 'जानकारी', text: '{segment} में आपकी रुचि क्यों है — नौकरी, कॉलेज क्रेडिट या कोई नई स्किल? आप कब से शुरू करना चाहेंगे?' },
    { title: 'पिच', text: 'आप जैसे ज़्यादातर छात्र इसे 4–6 हफ़्तों में पूरा कर लेते हैं — लाइव मेंटर सेशन, असली प्रोजेक्ट और एक सर्टिफ़िकेट जिसे कंपनियाँ मानती हैं।' },
    { title: 'क्लोज़', text: 'क्या मैं अभी आपको WhatsApp पर पूरी जानकारी भेज दूँ और आज की कीमत आपके लिए होल्ड कर दूँ?' },
  ],
  mr: [
    { title: 'सुरुवात', text: 'नमस्कार {name}, मी Internship Studio मधून {me} बोलत आहे. तुम्ही {segment} बद्दल चौकशी केली होती — आत्ता दोन मिनिटे बोलू शकतो का?' },
    { title: 'माहिती', text: '{segment} मध्ये तुम्हाला रस का आहे — नोकरी, कॉलेज क्रेडिट की नवीन कौशल्य? तुम्हाला कधीपासून सुरू करायला आवडेल?' },
    { title: 'पिच', text: 'तुमच्यासारखे बहुतेक विद्यार्थी हे 4–6 आठवड्यांत पूर्ण करतात — लाइव्ह मेंटर सेशन, खरे प्रोजेक्ट आणि कंपन्या मानतात असे प्रमाणपत्र.' },
    { title: 'क्लोज', text: 'मी आत्ताच तुम्हाला WhatsApp वर सगळी माहिती पाठवू का आणि आजची किंमत तुमच्यासाठी राखून ठेवू का?' },
  ],
  hinglish: [
    { title: 'Open', text: 'Hi {name}, main {me} bol raha/rahi hoon Internship Studio se. Aapne {segment} ke baare mein enquiry ki thi — kya abhi 2 minute baat ho sakti hai?' },
    { title: 'Discover', text: '{segment} kyun dekh rahe ho — job ke liye, college credit ya nayi skill? Kab se start karna chahoge?' },
    { title: 'Pitch', text: 'Aap jaise zyada tar students ise 4–6 weeks mein complete kar lete hain — live mentor sessions, real projects aur ek certificate jo recruiters maante hain.' },
    { title: 'Close', text: 'Main abhi WhatsApp pe saari details bhej deta/deti hoon aur aaj ka price aapke liye hold kar deta/deti hoon — theek hai?' },
  ],
};

export type Objection = 'expensive' | 'details' | 'family' | 'competitors' | 'later';

export const OBJECTIONS: { key: Objection; label: { [l in Lang]: string }; reply: { [l in Lang]: string } }[] = [
  {
    key: 'expensive',
    label: { en: 'Too expensive', hi: 'बहुत महँगा', mr: 'खूप महाग', hinglish: 'Bahut mehenga' },
    reply: {
      en: 'Totally fair. Think of it per week: it costs less than a weekend outing, and one internship offer pays it back many times over. We also have an EMI option — shall I check what your monthly would be?',
      hi: 'बिल्कुल सही बात है। हफ़्ते के हिसाब से देखें तो यह एक वीकेंड के ख़र्च से भी कम है, और एक इंटर्नशिप ऑफ़र इसकी कीमत कई गुना वापस दे देता है। EMI भी है — मैं देखूँ आपकी महीने की किश्त कितनी बनेगी?',
      mr: 'अगदी बरोबर. आठवड्याच्या हिशोबाने पाहिलं तर हे एका वीकेंडच्या खर्चापेक्षाही कमी आहे, आणि एक इंटर्नशिप ऑफर याची किंमत अनेक पटीने परत देते. EMI पण आहे — तुमचा महिन्याचा हप्ता किती येईल ते पाहू का?',
      hinglish: 'Bilkul fair point. Per week dekho toh ek weekend ke kharche se bhi kam hai, aur ek internship offer iska paisa kai guna wapas de deta hai. EMI bhi hai — main check karun aapki monthly kitni banegi?',
    },
  },
  {
    key: 'details',
    label: { en: 'Send details on WhatsApp', hi: 'WhatsApp पर भेजो', mr: 'WhatsApp वर पाठवा', hinglish: 'WhatsApp pe bhejo' },
    reply: {
      en: 'Sending it right now while we are on the call. Can you open it for me? I’ll walk you through the two things most students ask about — the projects and the certificate.',
      hi: 'मैं अभी कॉल पर रहते हुए भेज रहा/रही हूँ। क्या आप उसे खोल सकते हैं? मैं आपको वो दो चीज़ें बताता/बताती हूँ जो ज़्यादातर छात्र पूछते हैं — प्रोजेक्ट और सर्टिफ़िकेट।',
      mr: 'मी आत्ता कॉलवर असतानाच पाठवत आहे. तुम्ही ते उघडू शकता का? बहुतेक विद्यार्थी ज्या दोन गोष्टी विचारतात — प्रोजेक्ट आणि प्रमाणपत्र — त्या मी समजावून सांगतो/सांगते.',
      hinglish: 'Main abhi call pe hi bhej raha/rahi hoon. Ek baar open karoge? Main woh do cheezein bata deta/deti hoon jo sab students poochte hain — projects aur certificate.',
    },
  },
  {
    key: 'family',
    label: { en: 'Need to ask family / boss', hi: 'घरवालों से पूछना है', mr: 'घरच्यांना विचारायचं आहे', hinglish: 'Ghar pe poochna hai' },
    reply: {
      en: 'Of course — it’s a good decision to make together. What do you think they’ll ask? I can send a one-page summary for them, and we can do a quick 3-way call this evening if that helps.',
      hi: 'बिल्कुल — यह साथ में लेने वाला अच्छा फ़ैसला है। आपको क्या लगता है वे क्या पूछेंगे? मैं उनके लिए एक पेज की जानकारी भेज सकता/सकती हूँ, और चाहें तो आज शाम सबके साथ छोटी सी कॉल कर लेते हैं।',
      mr: 'नक्कीच — हा एकत्र घ्यायचा चांगला निर्णय आहे. त्यांना काय प्रश्न पडतील असं वाटतं? मी त्यांच्यासाठी एका पानाची माहिती पाठवू शकतो/शकते, आणि हवं तर आज संध्याकाळी सगळ्यांसोबत छोटा कॉल करूया.',
      hinglish: 'Bilkul — yeh saath mein lene wala decision hai. Unhe kya sawaal honge? Main ek page ka summary bhej deta/deti hoon, aur chaho toh aaj shaam sabke saath ek quick call kar lete hain.',
    },
  },
  {
    key: 'competitors',
    label: { en: 'Comparing competitors', hi: 'दूसरे भी देख रहे हैं', mr: 'इतर पर्याय पाहतोय', hinglish: 'Doosre bhi dekh rahe' },
    reply: {
      en: 'Smart to compare. Check three things anywhere you look: live mentors or only videos, real projects you can show in interviews, and placement support. Which of those matters most to you?',
      hi: 'तुलना करना समझदारी है। कहीं भी देखें, तीन चीज़ें ज़रूर देखें: लाइव मेंटर हैं या सिर्फ़ वीडियो, इंटरव्यू में दिखाने लायक असली प्रोजेक्ट, और प्लेसमेंट सपोर्ट। आपके लिए इनमें से सबसे ज़रूरी क्या है?',
      mr: 'तुलना करणं हुशारीचं आहे. कुठेही पाहा, तीन गोष्टी नक्की तपासा: लाइव्ह मेंटर की फक्त व्हिडिओ, मुलाखतीत दाखवता येतील असे खरे प्रोजेक्ट, आणि प्लेसमेंट सपोर्ट. तुमच्यासाठी यातलं सगळ्यात महत्त्वाचं काय?',
      hinglish: 'Compare karna smart hai. Kahin bhi dekho, teen cheezein check karna: live mentors ya sirf videos, real projects jo interview mein dikha sako, aur placement support. Aapke liye sabse important kya hai?',
    },
  },
  {
    key: 'later',
    label: { en: 'Call me later', hi: 'बाद में कॉल करो', mr: 'नंतर फोन करा', hinglish: 'Baad mein call karo' },
    reply: {
      en: 'No problem. What time works best — this evening or tomorrow morning? I’ll set a reminder and keep today’s offer open for you until then.',
      hi: 'कोई बात नहीं। कौन सा समय ठीक रहेगा — आज शाम या कल सुबह? मैं रिमाइंडर लगा देता/देती हूँ और तब तक आज का ऑफ़र आपके लिए खुला रखूँगा/रखूँगी।',
      mr: 'काही हरकत नाही. कोणती वेळ योग्य — आज संध्याकाळ की उद्या सकाळ? मी रिमाइंडर लावतो/लावते आणि तोपर्यंत आजची ऑफर तुमच्यासाठी चालू ठेवतो/ठेवते.',
      hinglish: 'Koi baat nahi. Kaunsa time best rahega — aaj shaam ya kal subah? Main reminder laga deta/deti hoon aur tab tak aaj ka offer aapke liye open rakhta/rakhti hoon.',
    },
  },
];

export type TemplateKey = 'missed' | 'brochure' | 'price' | 'demo' | 'recap' | 'offer' | 'revive' | 'thanks';

export const TEMPLATES: { [l in Lang]: { [k in TemplateKey]: string } } = {
  en: {
    missed: 'Hi {name}, this is {me} from Internship Studio. I tried calling you about {segment} — when is a good time to talk?',
    brochure: 'Hi {name}, as promised, here are the full details of {segment}: {link}',
    price: 'Hi {name}, here is the plan comparison for {segment}: {price} {link}',
    demo: 'Hi {name}, here is the free demo session for {segment} — have a look: {link}',
    recap: 'Hi {name}, thanks for your time today! Quick recap: {segment}, live mentors, real projects and a certificate. Reply here with any question. — {me}',
    offer: 'Hi {name}, a quick reminder: the price I held for you for {segment} ends at {until}. Reply YES and I’ll reserve your seat.',
    revive: 'Hi {name}, {me} from Internship Studio here. Still thinking about {segment}? This week’s batch has a few seats left — want me to hold one?',
    thanks: 'Hi {name}, welcome aboard {segment}! 🎉 Thank you for trusting us. If a friend would like the same, just share their number with me.',
  },
  hi: {
    missed: 'नमस्ते {name}, मैं Internship Studio से {me}। मैंने आपको {segment} के बारे में कॉल किया था — बात करने का सही समय कब है?',
    brochure: 'नमस्ते {name}, जैसा कहा था, {segment} की पूरी जानकारी: {link}',
    price: 'नमस्ते {name}, {segment} के प्लान की तुलना: {price} {link}',
    demo: 'नमस्ते {name}, {segment} का फ़्री डेमो सेशन — ज़रूर देखें: {link}',
    recap: 'नमस्ते {name}, आज समय देने के लिए धन्यवाद! संक्षेप में: {segment}, लाइव मेंटर, असली प्रोजेक्ट और सर्टिफ़िकेट। कोई भी सवाल यहीं पूछें। — {me}',
    offer: 'नमस्ते {name}, याद दिला दूँ: {segment} की जो कीमत आपके लिए होल्ड की थी वह {until} पर ख़त्म हो रही है। YES लिखें, मैं आपकी सीट पक्की कर दूँगा/दूँगी।',
    revive: 'नमस्ते {name}, Internship Studio से {me}। क्या आप अब भी {segment} के बारे में सोच रहे हैं? इस हफ़्ते के बैच में कुछ ही सीटें बची हैं — एक आपके लिए रखूँ?',
    thanks: 'नमस्ते {name}, {segment} में आपका स्वागत है! 🎉 भरोसा करने के लिए धन्यवाद। अगर किसी दोस्त को भी यही चाहिए तो उनका नंबर मुझे भेज दें।',
  },
  mr: {
    missed: 'नमस्कार {name}, मी Internship Studio मधून {me}. मी तुम्हाला {segment} बद्दल फोन केला होता — बोलायला कोणती वेळ योग्य आहे?',
    brochure: 'नमस्कार {name}, ठरल्याप्रमाणे {segment} ची संपूर्ण माहिती: {link}',
    price: 'नमस्कार {name}, {segment} च्या प्लॅनची तुलना: {price} {link}',
    demo: 'नमस्कार {name}, {segment} चं मोफत डेमो सेशन — नक्की पाहा: {link}',
    recap: 'नमस्कार {name}, आज वेळ दिल्याबद्दल धन्यवाद! थोडक्यात: {segment}, लाइव्ह मेंटर, खरे प्रोजेक्ट आणि प्रमाणपत्र. काही प्रश्न असल्यास इथेच विचारा. — {me}',
    offer: 'नमस्कार {name}, आठवण करून देतो/देते: {segment} ची तुमच्यासाठी राखलेली किंमत {until} ला संपते. YES लिहा, मी तुमची जागा निश्चित करतो/करते.',
    revive: 'नमस्कार {name}, Internship Studio मधून {me}. तुम्ही अजूनही {segment} बद्दल विचार करताय का? या आठवड्याच्या बॅचमध्ये काहीच जागा उरल्या आहेत — एक तुमच्यासाठी ठेवू का?',
    thanks: 'नमस्कार {name}, {segment} मध्ये तुमचं स्वागत! 🎉 विश्वास ठेवल्याबद्दल धन्यवाद. मित्रालाही हवं असल्यास त्यांचा नंबर मला पाठवा.',
  },
  hinglish: {
    missed: 'Hi {name}, main {me} Internship Studio se. Maine aapko {segment} ke liye call kiya tha — baat karne ka sahi time kab hai?',
    brochure: 'Hi {name}, jaisa bola tha, {segment} ki full details: {link}',
    price: 'Hi {name}, {segment} ke plans ka comparison: {price} {link}',
    demo: 'Hi {name}, {segment} ka free demo session — zaroor dekhna: {link}',
    recap: 'Hi {name}, aaj time dene ke liye thanks! Quick recap: {segment}, live mentors, real projects aur certificate. Koi bhi sawaal yahin pooch lo. — {me}',
    offer: 'Hi {name}, reminder: {segment} ka jo price aapke liye hold kiya tha woh {until} pe khatam ho raha hai. YES reply karo, main seat confirm kar deta/deti hoon.',
    revive: 'Hi {name}, {me} here from Internship Studio. Abhi bhi {segment} ke baare mein soch rahe ho? Is week ke batch mein kuch hi seats bachi hain — ek hold karun?',
    thanks: 'Hi {name}, {segment} mein welcome! 🎉 Trust karne ke liye thank you. Kisi dost ko bhi chahiye toh unka number mujhe bhej do.',
  },
};

/* The mid-call pitch buttons, and the link each one sends (set once, in the workspace). */
export const PITCHES: { key: TemplateKey; label: string; link: keyof SalesLinks | null }[] = [
  { key: 'brochure', label: 'Brochure / details', link: 'brochure' },
  { key: 'price', label: 'Price / plans', link: 'pricing' },
  { key: 'demo', label: 'Demo link', link: 'demo' },
  { key: 'recap', label: 'Call recap', link: null },
];

export interface SalesLinks { brochure: string; pricing: string; demo: string; priceText: string; lang: Lang }
export const DEFAULT_LINKS: SalesLinks = { brochure: '', pricing: '', demo: '', priceText: '', lang: 'en' };
export const CACHE_LINKS = 'sales_links_v1';

export const fillSales = (text: string, v: { name?: string; segment?: string; me?: string; link?: string; price?: string; until?: string }) => text
  .replace(/\{name\}/gi, (v.name || '').trim().split(/\s+/)[0] || 'there')
  .replace(/\{segment\}/gi, OFFER)
  .replace(/\{me\}/gi, v.me || 'our team')
  .replace(/\{link\}/gi, v.link || '')
  .replace(/\{price\}/gi, v.price || '')
  .replace(/\{until\}/gi, v.until || '')
  .replace(/[ \t]+$/gm, '')
  .trim();

/* ── Drip: three follow-ups for a lead who has not answered — cancelled the moment they reply on
   WhatsApp or pick up a call. ── */
export const DRIP_STEPS: { afterMin: number; label: string }[] = [
  { afterMin: 0, label: 'Now' },
  { afterMin: 24 * 60, label: 'After 24 h' },
  { afterMin: 48 * 60, label: 'After 48 h' },
];
export const DRIP: { [l in Lang]: [string, string, string] } = {
  en: [
    'Hi {name}, this is {me} from Internship Studio. I tried calling you about {segment} — reply here and I’ll call at a time that suits you.',
    'Hi {name}, just following up on {segment}. Most students ask about the projects and the certificate — happy to explain in 2 minutes. When can I call?',
    'Hi {name}, last check-in from me about {segment}. If now isn’t the right time, no problem — reply LATER and I’ll reach out next month.',
  ],
  hi: [
    'नमस्ते {name}, मैं Internship Studio से {me}। मैंने आपको {segment} के बारे में कॉल किया था — यहाँ जवाब दें, मैं आपके सुविधाजनक समय पर कॉल करूँगा/करूँगी।',
    'नमस्ते {name}, {segment} के बारे में याद दिला रहा/रही हूँ। ज़्यादातर छात्र प्रोजेक्ट और सर्टिफ़िकेट के बारे में पूछते हैं — 2 मिनट में बता दूँगा/दूँगी। कब कॉल करूँ?',
    'नमस्ते {name}, {segment} के बारे में यह मेरा आख़िरी मैसेज है। अभी सही समय नहीं है तो कोई बात नहीं — LATER लिखें, मैं अगले महीने संपर्क करूँगा/करूँगी।',
  ],
  mr: [
    'नमस्कार {name}, मी Internship Studio मधून {me}. मी तुम्हाला {segment} बद्दल फोन केला होता — इथे उत्तर द्या, मी तुमच्या सोयीच्या वेळी फोन करेन.',
    'नमस्कार {name}, {segment} बद्दल आठवण करून देतो/देते. बहुतेक विद्यार्थी प्रोजेक्ट आणि प्रमाणपत्राबद्दल विचारतात — 2 मिनिटांत सांगेन. कधी फोन करू?',
    'नमस्कार {name}, {segment} बद्दल हा माझा शेवटचा मेसेज. आत्ता योग्य वेळ नसेल तर हरकत नाही — LATER लिहा, मी पुढच्या महिन्यात संपर्क करेन.',
  ],
  hinglish: [
    'Hi {name}, main {me} Internship Studio se. Maine aapko {segment} ke liye call kiya tha — yahan reply karo, main aapke time pe call kar lunga/lungi.',
    'Hi {name}, {segment} ke baare mein follow up. Zyada tar students projects aur certificate ke baare mein poochte hain — 2 minute mein bata dunga/dungi. Kab call karun?',
    'Hi {name}, {segment} ke baare mein last message. Abhi sahi time nahi hai toh koi baat nahi — LATER reply karo, main next month contact karunga/karungi.',
  ],
};

/* ── Offer calculator: the summary sent to the lead. ── */
export const OFFER_SUMMARY: { [l in Lang]: string } = {
  en: 'Hi {name}, here is the offer we discussed for {segment}:\n• Plan: {plan}\n• Price: {price}\n• On-call special: {discount}% off → {final}\n• {emi}\n{validity}\nReply YES to reserve your seat. — {me}',
  hi: 'नमस्ते {name}, {segment} के लिए हमने जो ऑफ़र बात किया:\n• प्लान: {plan}\n• कीमत: {price}\n• कॉल पर विशेष छूट: {discount}% → {final}\n• {emi}\n{validity}\nसीट पक्की करने के लिए YES लिखें। — {me}',
  mr: 'नमस्कार {name}, {segment} साठी आपण ठरवलेली ऑफर:\n• प्लॅन: {plan}\n• किंमत: {price}\n• कॉलवरील विशेष सवलत: {discount}% → {final}\n• {emi}\n{validity}\nजागा निश्चित करण्यासाठी YES लिहा. — {me}',
  hinglish: 'Hi {name}, {segment} ke liye jo offer discuss kiya:\n• Plan: {plan}\n• Price: {price}\n• On-call special: {discount}% off → {final}\n• {emi}\n{validity}\nSeat reserve karne ke liye YES reply karo. — {me}',
};
export const EMI_LINE: { [l in Lang]: (months: number, per: string) => string } = {
  en: (m, per) => (m > 1 ? `Easy EMI: ${m} × ${per} (no extra cost)` : 'One-time payment'),
  hi: (m, per) => (m > 1 ? `आसान EMI: ${m} × ${per} (कोई अतिरिक्त ख़र्च नहीं)` : 'एक बार में भुगतान'),
  mr: (m, per) => (m > 1 ? `सोपा EMI: ${m} × ${per} (जादा खर्च नाही)` : 'एकरकमी भरणा'),
  hinglish: (m, per) => (m > 1 ? `Easy EMI: ${m} × ${per} (no extra cost)` : 'One-time payment'),
};
export const VALIDITY_LINE: { [l in Lang]: (until: string) => string } = {
  en: (u) => (u ? `This price is held for you until ${u}.` : ''),
  hi: (u) => (u ? `यह कीमत ${u} तक आपके लिए होल्ड है।` : ''),
  mr: (u) => (u ? `ही किंमत ${u} पर्यंत तुमच्यासाठी राखून ठेवली आहे.` : ''),
  hinglish: (u) => (u ? `Yeh price ${u} tak aapke liye hold hai.` : ''),
};
export const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

export const DEFAULT_PLANS = [
  { name: 'Basic', price: 4999, note: 'Recorded lessons + certificate' },
  { name: 'Pro', price: 7999, note: 'Live mentor sessions + projects' },
  { name: 'Placement', price: 12999, note: 'Pro + placement support' },
];

/* The battle matrix starts with what we offer filled in and the competitors' columns empty: the
   team fills those in from what students actually tell them (Stats → admin, or in Focus). */
export const DEFAULT_BATTLE = {
  criteria: ['Live mentor sessions', 'Real projects for the CV', 'Recognised certificate', 'Placement support', 'Price', 'EMI', 'Batch timings'],
  us: ['Yes, every week', 'Yes, 2–3 projects', 'Yes', 'Yes (Placement plan)', 'From ₹4,999', 'Yes, no extra cost', 'Weekday & weekend'],
  competitors: [
    { name: 'Internshala', values: [] as string[] },
    { name: 'Coursera', values: [] as string[] },
    { name: 'Udemy', values: [] as string[] },
    { name: 'upGrad', values: [] as string[] },
    { name: 'Other', values: [] as string[] },
  ],
};
