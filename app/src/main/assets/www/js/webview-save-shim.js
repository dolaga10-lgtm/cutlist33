/* Routes download() calls to the native Android file picker (مدير الملفات) when running inside the app's WebView.
   - عند استخراج صورة (JPEG) أو ملف PDF (أو CSV / نسخة احتياطية): يفتح مدير الملفات ليختار المستخدم مكان الحفظ بالضبط.
   - أما حفظ المشروعات في قائمة العملاء فيتم داخلياً في التطبيق بدون استدعاء download(). */
(function () {
    var orig = window.download;
    if (typeof orig !== 'function') return;

    window.download = function (data, name, mime) {
        if (window.NativeSaver) {
            try {
                name = name || 'download';
                if (typeof data === 'string' && data.indexOf('data:') === 0) {
                    NativeSaver.pickSaveDataUrl(data, name, mime || '');
                    return true;
                }
                if (typeof Blob !== 'undefined' && data instanceof Blob) {
                    var r = new FileReader();
                    r.onload = function () {
                        var m = mime || data.type || '';
                        NativeSaver.pickSaveDataUrl(String(r.result), name, m);
                    };
                    r.readAsDataURL(data);
                    return true;
                }
                if (typeof data === 'string') {
                    NativeSaver.pickSaveText(data, name, mime || 'text/plain');
                    return true;
                }
            } catch (e) { console.error('NativeSaver failed', e); }
        }
        return orig.apply(this, arguments);
    };
})();
