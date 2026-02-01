# Advanced Multimedia Editing

Edit videos, images, and audio directly using command-line tools.

## Video Editing (FFmpeg)

### Basic Operations
```bash
# Convert format
ffmpeg -i input.mp4 output.avi

# Trim video (start at 00:01:00, duration 30 seconds)
ffmpeg -i input.mp4 -ss 00:01:00 -t 30 -c copy output.mp4

# Extract audio from video
ffmpeg -i video.mp4 -vn -acodec mp3 audio.mp3

# Remove audio from video
ffmpeg -i input.mp4 -an -c:v copy output.mp4

# Resize video
ffmpeg -i input.mp4 -vf "scale=1280:720" output.mp4

# Change framerate
ffmpeg -i input.mp4 -r 30 output.mp4
```

### Advanced Video
```bash
# Concatenate videos (create list.txt with: file 'video1.mp4'\nfile 'video2.mp4')
ffmpeg -f concat -safe 0 -i list.txt -c copy output.mp4

# Add text overlay
ffmpeg -i input.mp4 -vf "drawtext=text='FRIDAY':fontsize=24:fontcolor=white:x=10:y=10" output.mp4

# Add image watermark
ffmpeg -i input.mp4 -i watermark.png -filter_complex "overlay=10:10" output.mp4

# Create GIF from video
ffmpeg -i input.mp4 -vf "fps=10,scale=320:-1:flags=lanczos" -c:v gif output.gif

# Speed up/slow down
ffmpeg -i input.mp4 -filter:v "setpts=0.5*PTS" output.mp4  # 2x speed
ffmpeg -i input.mp4 -filter:v "setpts=2.0*PTS" output.mp4  # 0.5x speed
```

## Image Editing (ImageMagick)

### Basic Operations
```bash
# Convert format
convert input.png output.jpg

# Resize image
convert input.png -resize 800x600 output.png
convert input.png -resize 50% output.png

# Crop image (WxH+X+Y)
convert input.png -crop 400x300+100+50 output.png

# Rotate
convert input.png -rotate 90 output.png

# Add border
convert input.png -border 10x10 -bordercolor black output.png
```

### Advanced Image
```bash
# Add text to image
convert input.png -pointsize 36 -fill white -annotate +50+50 "FRIDAY" output.png

# Combine images horizontally/vertically
convert image1.png image2.png +append horizontal.png
convert image1.png image2.png -append vertical.png

# Create thumbnail
convert input.png -thumbnail 150x150^ -gravity center -extent 150x150 thumb.png

# Apply filters
convert input.png -blur 0x8 blurred.png
convert input.png -sharpen 0x1 sharpened.png
convert input.png -modulate 100,0 grayscale.png
convert input.png -negate inverted.png

# Batch process
mogrify -resize 800x600 -format jpg *.png
```

## Audio Editing (FFmpeg/SoX)

### FFmpeg Audio
```bash
# Convert audio format
ffmpeg -i input.wav output.mp3

# Trim audio
ffmpeg -i input.mp3 -ss 00:00:30 -t 60 output.mp3

# Merge audio files
ffmpeg -i "concat:audio1.mp3|audio2.mp3" -acodec copy output.mp3

# Adjust volume
ffmpeg -i input.mp3 -filter:a "volume=1.5" louder.mp3

# Change speed without pitch
ffmpeg -i input.mp3 -filter:a "atempo=1.5" faster.mp3
```

### SoX Audio
```bash
# Trim audio
sox input.wav output.wav trim 0 30

# Combine audio
sox input1.wav input2.wav output.wav

# Add effects
sox input.wav output.wav reverb
sox input.wav output.wav echo 0.8 0.88 60 0.4
sox input.wav output.wav fade 3 0 3

# Normalize volume
sox input.wav output.wav norm

# Generate tone
sox -n output.wav synth 5 sine 440
```

## Tools Required
- `ffmpeg` - Video/audio processing
- `imagemagick` - Image processing
- `sox` - Audio processing
- `gifsicle` - GIF optimization

## Installation
```bash
sudo apt install -y ffmpeg imagemagick sox gifsicle
```
