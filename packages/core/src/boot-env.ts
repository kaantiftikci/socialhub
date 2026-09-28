// libuv iş parçacığı havuzu (eşzamansız dosya G/Ç, zlib, kripto): varsayılan 4. WhatsApp geçmiş eşitlemesinde binlerce anahtar/
// medya kaydı yazımı ve geçmiş paketlerinin zlib açılması aynı havuzda sıraya giriyordu. Havuz ilk eşzamansız işte kurulduğu için
// değer, her şeyden ÖNCE (index.ts'nin ilk içe aktarımı) ayarlanır.
process.env.UV_THREADPOOL_SIZE ??= '16';
export {};
