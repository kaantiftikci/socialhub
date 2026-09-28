/**
 * Platformların İngilizce tepki metinleri → Türkçe. Instagram/Messenger/LinkedIn/X liste önizlemesi ("Liked a message",
 * "Ayşe reacted ❤️ to your message") ve Android'den iMessage'a SMS olarak gelen tepkiler ("Liked “yarın görüşelim”")
 * olduğu gibi görünüyordu. Metnin TAMAMI tepki kalıbıysa çevrilir; başka her metin aynen döner.
 * (Aynı işlev arayüzde apps/web/src/reaction-text.ts — eski kayıtlar da Türkçe görünsün.)
 */
const VERB: Record<string, [string, string]> = {
  liked: ['👍', 'beğendi'],
  loved: ['❤️', 'sevdi'],
  'laughed at': ['😂', 'güldü'],
  emphasized: ['‼️', 'vurguladı'],
  emphasised: ['‼️', 'vurguladı'],
  disliked: ['👎', 'beğenmedi'],
  questioned: ['❓', 'soru işaretiyle yanıtladı'],
};
const VERBS = 'liked|loved|laughed at|emphasi[sz]ed|disliked|questioned';
const OBJ: Record<string, string> = {
  'a message': 'bir mesajı',
  'your message': 'mesajını',
  'an attachment': 'bir eki',
  'a photo': 'bir fotoğrafı',
  'an image': 'bir görseli',
  'a video': 'bir videoyu',
  'a story': 'bir hikâyeyi',
  'your story': 'hikâyeni',
};
const OBJS = Object.keys(OBJ).join('|');
const verbOf = (v: string) => VERB[v.toLowerCase().replace('emphasised', 'emphasized')] ?? VERB.liked;
// "güldü" gibi -e hâli isteyen fiillerde nesne: "bir mesajı" → "bir mesaja"
const dative = (verb: string, obj: string) => (verb === 'güldü' ? obj.replace(/ı$/, 'a').replace(/i$/, 'e').replace(/u$/, 'a').replace(/ü$/, 'e') : obj);
const who = (name: string | undefined) => (name && !/^you$/i.test(name) ? `${name} ` : '');

export function trReactionText(text: string): string {
  const s = text.trim();
  if (!s || s.length > 400 || !/[a-z]/i.test(s)) return text;
  let m: RegExpMatchArray | null;
  // "Liked a message" · "Ayşe liked your message" · "You loved a photo"
  if ((m = s.match(new RegExp(`^(?:(.{1,60}?) )?(${VERBS}) (${OBJS})\\.?$`, 'i')))) {
    const [emoji, verb] = verbOf(m[2]);
    const obj = OBJ[m[3].toLowerCase()];
    if (/^you$/i.test(m[1] ?? '')) return `${emoji} ${cap(dative(verb, obj.replace(/^mesajını$/, 'mesajı')))} ${verbSelf(verb)}`;
    return `${emoji} ${m[1] ? who(m[1]) + dative(verb, obj) : cap(dative(verb, obj))} ${verb}`;
  }
  // "Ayşe reacted ❤️ to your message" · "Reacted 😂 to a message" · "You reacted 👍 to Ali's message"
  if ((m = s.match(/^(?:(.{1,60}?) )?reacted (.{1,16}?) to (?:your|a|an|their|his|her|(.{1,60}?)'s) (message|photo|video|attachment|story)\.?$/i))) {
    if (/^you$/i.test(m[1] ?? '')) return `${m[2]} ${m[3] ? `${m[3]} adlı kişinin mesajına` : 'Mesaja'} tepki verdin`;
    return `${m[2]} ${m[1] ? `${m[1]} mesajına` : 'Bir mesaja'} tepki verdi`;
  }
  // SMS/RCS tepkileri: 'Liked “yarın görüşelim”' · 'Laughed at "foto"' · 'Reacted ❤️ to “…”' · 'Removed a like from “…”'
  if ((m = s.match(new RegExp(`^(${VERBS}) [“"'‘](.+)[”"'’]$`, 'is')))) {
    const [emoji, verb] = verbOf(m[1]);
    return `${emoji} “${m[2]}” ${verb === 'güldü' ? 'mesajına' : 'mesajını'} ${verb}`;
  }
  if ((m = s.match(/^reacted (.{1,16}?) to [“"'‘](.+)[”"'’]$/is))) return `${m[1]} “${m[2]}” mesajına tepki verdi`;
  if ((m = s.match(/^removed an? (like|heart|laugh|emphasis|dislike|question mark|exclamation|\S{1,12}) from [“"'‘](.+)[”"'’]$/is))) return `“${m[2]}” mesajındaki tepkisini geri aldı`;
  return text;
}

const cap = (s: string) => s.charAt(0).toLocaleUpperCase('tr') + s.slice(1);
function verbSelf(v: string): string {
  return v.replace(/di$/, 'din').replace(/dı$/, 'dın').replace(/du$/, 'dun').replace(/dü$/, 'dün').replace(/ti$/, 'tin');
}
