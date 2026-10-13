// Resize before signing/uploading so large photos fit the metadata transport limit.
export async function prepareLaunchImage(file: File): Promise<File> {
  if (!file.size || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw Error('Choose a PNG, JPG, WebP or GIF image.');
  if (file.size > 20 * 1024 * 1024) throw Error('Choose an image up to 20 MB.');
  // Keep GIF animation; the server fits every frame into a square.
  if (file.type === 'image/gif') {
    if (file.size > 2 * 1024 * 1024) throw Error('Animated GIFs can be up to 2 MB.');
    return file;
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url; await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw Error('Could not read this image.');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
    const context = canvas.getContext('2d'); if (!context) throw Error('Image resizing is unavailable.');
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    const scale = 1024 / Math.max(image.naturalWidth, image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    context.drawImage(image, (1024-width)/2, (1024-height)/2, width, height);
    const encode = (type: string, quality?: number) => new Promise<Blob>((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(Error('Could not resize this image.')),type,quality));
    let blob = await encode('image/png');
    if (blob.size > 2 * 1024 * 1024) {
      context.globalCompositeOperation = 'destination-over'; context.fillStyle = '#0b0915'; context.fillRect(0,0,1024,1024);
      blob = await encode('image/jpeg',0.9);
    }
    if (blob.size > 2 * 1024 * 1024) throw Error('Could not compress this image. Try another image.');
    return new File([blob],file.name.replace(/\.[^.]+$/,'')+(blob.type==='image/png'?'.png':'.jpg'),{type:blob.type});
  } finally { URL.revokeObjectURL(url); }
}
