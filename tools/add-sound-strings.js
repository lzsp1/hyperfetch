'use strict';
/** add-sound-strings.js — adds completion-feedback keys to every language. */
const fs = require('fs');
const P = 'D:/HyperFetch/src/shared/i18n.js';
let s = fs.readFileSync(P, 'utf8');

const additions = {
  en: {
    'settings.feedback': 'Completion feedback',
    'settings.feedbackDesc': 'Chime and notification when a download ends',
    'settings.soundDone': 'Chime on success',
    'settings.soundDoneDesc': 'A short rising chime when a download finishes',
    'settings.soundFail': 'Chime on failure',
    'settings.soundFailDesc': 'A different low chime when a download fails',
    'settings.soundVolume': 'Chime volume',
    'settings.notifyDone': 'Desktop notification',
    'settings.notifyDoneDesc': 'System toast when the window is not focused',
    'settings.preview': 'Preview',
    'settings.soundDonePreview': 'Play the success chime',
    'settings.soundFailPreview': 'Play the failure chime',
    'notify.doneTitle': 'Download complete',
    'notify.doneBody': '{name} has finished downloading',
    'notify.failedTitle': 'Download failed',
    'notify.failedBody': '{name} — {error}',
    'notify.unsupported': 'System notifications are not available on this system',
    'toast.notifyBlocked': 'Notifications are blocked by the system',
    'preview.notification': 'This is how a notification looks',
  },
  'zh-CN': {
    'settings.feedback': '完成提示',
    'settings.feedbackDesc': '下载结束时的提示音与通知',
    'settings.soundDone': '下载成功提示音',
    'settings.soundDoneDesc': '下载完成时播放上扬的提示音',
    'settings.soundFail': '下载失败提示音',
    'settings.soundFailDesc': '下载失败时播放不同的低沉提示音',
    'settings.soundVolume': '提示音音量',
    'settings.notifyDone': '桌面通知',
    'settings.notifyDoneDesc': '窗口不在前台时弹出系统通知',
    'settings.preview': '试听',
    'settings.soundDonePreview': '播放成功提示音',
    'settings.soundFailPreview': '播放失败提示音',
    'notify.doneTitle': '下载完成',
    'notify.doneBody': '「{name}」已下载完成',
    'notify.failedTitle': '下载失败',
    'notify.failedBody': '「{name}」下载失败 — {error}',
    'notify.unsupported': '当前系统不支持桌面通知',
    'toast.notifyBlocked': '桌面通知被系统拦截',
    'preview.notification': '通知效果预览',
  },
  fr: {
    'settings.feedback': 'Retour de fin',
    'settings.feedbackDesc': 'Son et notification à la fin d’un téléchargement',
    'settings.soundDone': 'Son de réussite',
    'settings.soundDoneDesc': 'Un carillon montant quand un téléchargement se termine',
    'settings.soundFail': 'Son d’échec',
    'settings.soundFailDesc': 'Un carillon grave différent en cas d’échec',
    'settings.soundVolume': 'Volume du carillon',
    'settings.notifyDone': 'Notification du bureau',
    'settings.notifyDoneDesc': 'Toast système quand la fenêtre n’est pas active',
    'settings.preview': 'Écouter',
    'settings.soundDonePreview': 'Jouer le son de réussite',
    'settings.soundFailPreview': 'Jouer le son d’échec',
    'notify.doneTitle': 'Téléchargement terminé',
    'notify.doneBody': '{name} est téléchargé',
    'notify.failedTitle': 'Téléchargement échoué',
    'notify.failedBody': '{name} — {error}',
    'notify.unsupported': 'Les notifications système ne sont pas disponibles',
    'toast.notifyBlocked': 'Les notifications sont bloquées par le système',
    'preview.notification': 'Voici à quoi ressemble une notification',
  },
  es: {
    'settings.feedback': 'Aviso al terminar',
    'settings.feedbackDesc': 'Sonido y notificación al acabar una descarga',
    'settings.soundDone': 'Sonido al completar',
    'settings.soundDoneDesc': 'Un tono ascendente cuando termina una descarga',
    'settings.soundFail': 'Sonido al fallar',
    'settings.soundFailDesc': 'Un tono grave distinto cuando falla una descarga',
    'settings.soundVolume': 'Volumen del sonido',
    'settings.notifyDone': 'Notificación de escritorio',
    'settings.notifyDoneDesc': 'Aviso del sistema si la ventana no está activa',
    'settings.preview': 'Escuchar',
    'settings.soundDonePreview': 'Reproducir el sonido de éxito',
    'settings.soundFailPreview': 'Reproducir el sonido de error',
    'notify.doneTitle': 'Descarga completada',
    'notify.doneBody': '{name} se ha descargado',
    'notify.failedTitle': 'La descarga falló',
    'notify.failedBody': '{name} — {error}',
    'notify.unsupported': 'Las notificaciones del sistema no están disponibles',
    'toast.notifyBlocked': 'El sistema bloquea las notificaciones',
    'preview.notification': 'Así se ve una notificación',
  },
  ru: {
    'settings.feedback': 'Оповещение о завершении',
    'settings.feedbackDesc': 'Звук и уведомление по окончании загрузки',
    'settings.soundDone': 'Звук при успехе',
    'settings.soundDoneDesc': 'Восходящий сигнал после успешной загрузки',
    'settings.soundFail': 'Звук при ошибке',
    'settings.soundFailDesc': 'Другой низкий сигнал при неудаче',
    'settings.soundVolume': 'Громкость сигнала',
    'settings.notifyDone': 'Системное уведомление',
    'settings.notifyDoneDesc': 'Всплывающее уведомление, если окно не активно',
    'settings.preview': 'Послушать',
    'settings.soundDonePreview': 'Воспроизвести звук успеха',
    'settings.soundFailPreview': 'Воспроизвести звук ошибки',
    'notify.doneTitle': 'Загрузка завершена',
    'notify.doneBody': '{name} загружен',
    'notify.failedTitle': 'Загрузка не удалась',
    'notify.failedBody': '{name} — {error}',
    'notify.unsupported': 'Системные уведомления недоступны',
    'toast.notifyBlocked': 'Уведомления заблокированы системой',
    'preview.notification': 'Так выглядит уведомление',
  },
  ar: {
    'settings.feedback': 'تنبيه الانتهاء',
    'settings.feedbackDesc': 'صوت وإشعار عند انتهاء التنزيل',
    'settings.soundDone': 'صوت عند النجاح',
    'settings.soundDoneDesc': 'نغمة صاعدة عند اكتمال التنزيل',
    'settings.soundFail': 'صوت عند الفشل',
    'settings.soundFailDesc': 'نغمة منخفضة مختلفة عند فشل التنزيل',
    'settings.soundVolume': 'مستوى الصوت',
    'settings.notifyDone': 'إشعار سطح المكتب',
    'settings.notifyDoneDesc': 'إشعار نظام عندما لا تكون النافذة في المقدمة',
    'settings.preview': 'استماع',
    'settings.soundDonePreview': 'تشغيل صوت النجاح',
    'settings.soundFailPreview': 'تشغيل صوت الفشل',
    'notify.doneTitle': 'اكتمل التنزيل',
    'notify.doneBody': 'تم تنزيل {name}',
    'notify.failedTitle': 'فشل التنزيل',
    'notify.failedBody': '{name} — {error}',
    'notify.unsupported': 'إشعارات النظام غير متاحة',
    'toast.notifyBlocked': 'الإشعارات محجوبة من النظام',
    'preview.notification': 'هكذا يبدو الإشعار',
  },
};

const anchors = {
  en: '\n};\n\nconst zhCN = {',
  'zh-CN': '\n};\n\nconst fr = {',
  fr: '\n};\n\nconst es = {',
  es: '\n};\n\nconst ru = {',
  ru: '\n};\n\nconst ar = {',
  ar: '\n};\n\nconst MESSAGES =',
};

for (const [code, extra] of Object.entries(additions)) {
  const anchor = anchors[code];
  if (!s.includes(anchor)) {
    console.log('anchor missing for', code);
    continue;
  }
  const body = Object.entries(extra)
    .map(([k, v]) => `  '${k}': ${JSON.stringify(v)},`)
    .join('\n');
  s = s.replace(anchor, `\n${body}${anchor}`);
}
fs.writeFileSync(P, s, 'utf8');
console.log('completion-feedback keys added');
