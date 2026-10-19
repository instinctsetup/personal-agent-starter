#!/bin/bash
# Concat cards + scenes into final mp4 (1280x720, silent audio, <16MB target)
set -e
cd /home/sandbox/demo
CAT=/tmp/allclips.txt; : > $CAT
i=0
for item in "${ORDER[@]}"; do
  if [[ $item == card* ]]; then
    f="/tmp/clip_card$i.mp4"
    ffmpeg -y -loglevel error -loop 1 -t 3.4 -i assets/$item.png -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x12141a" -r 30 -pix_fmt yuv420p -c:v libx264 -crf 26 $f
    echo "file '$f'" >> $CAT; i=$((i+1))
  elif [[ $item == dash ]]; then
    f="/tmp/clip_dash.mp4"
    ffmpeg -y -loglevel error -loop 1 -t 8 -i assets/dashboard.png -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x12141a" -r 30 -pix_fmt yuv420p -c:v libx264 -crf 26 $f
    echo "file '$f'" >> $CAT
  else
    f="/tmp/clip_$item.mp4"
    ffmpeg -y -loglevel error -f concat -safe 0 -i lists/$item.txt -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x12141a" -r 30 -pix_fmt yuv420p -c:v libx264 -crf 26 $f
    echo "file '$f'" >> $CAT
  fi
done
ffmpeg -y -loglevel error -f concat -safe 0 -i $CAT -c:v libx264 -crf 28 -pix_fmt yuv420p -f lavfi -i anullsrc=r=44100:cl=mono -shortest -c:a aac -b:a 64k out/demo.mp4
ls -la out/demo.mp4
