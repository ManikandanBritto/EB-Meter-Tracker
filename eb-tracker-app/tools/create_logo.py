from PIL import Image, ImageDraw, ImageFont
import math
import os

os.makedirs('assets', exist_ok=True)

W, H = 1024, 1024
img = Image.new('RGBA', (W, H), (245, 245, 245, 255))
d = ImageDraw.Draw(img)

# soft glow behind icon
for radius in range(430, 160, -30):
    alpha = max(0, 120 - (430 - radius))
    d.ellipse((512-radius, 512-radius, 512+radius, 512+radius), outline=(52, 209, 190, alpha), width=40)

# circle boundary
outer = (72, 72, 952, 952)
d.ellipse(outer, outline=(7, 67, 110, 255), width=26, fill=(255, 255, 255, 255))

# stylized arc / meter ring
cx, cy = 512, 512
for angle in range(220, 520, 10):
    a1 = math.radians(angle)
    a2 = math.radians(angle + 12)
    x1 = cx + 230 * math.cos(a1)
    y1 = cy + 230 * math.sin(a1)
    x2 = cx + 305 * math.cos(a2)
    y2 = cy + 305 * math.sin(a2)
    d.line((x1, y1, x2, y2), fill=(35, 168, 201, 255), width=28)

# inner arc segments in teal
for angle in range(180, 420, 12):
    a1 = math.radians(angle)
    a2 = math.radians(angle + 12)
    x1 = cx + 150 * math.cos(a1)
    y1 = cy + 150 * math.sin(a1)
    x2 = cx + 230 * math.cos(a2)
    y2 = cy + 230 * math.sin(a2)
    d.line((x1, y1, x2, y2), fill=(45, 199, 179, 255), width=20)

# needle
needle = (500, 500, 650, 420)
d.line((512, 512, 650, 430), fill=(17, 75, 109, 255), width=18)
d.ellipse((470, 470, 550, 550), fill=(16, 94, 127, 255))

# brand text
font_big = ImageFont.truetype('DejaVuSans-Bold.ttf', 170)
font_small = ImageFont.truetype('DejaVuSans-Bold.ttf', 62)

text = 'EBT'
left, top, right, bottom = d.textbbox((0, 0), text, font=font_big)
text_width = right - left
text_height = bottom - top
x = (W - text_width) / 2
# place lower to emulate logo composition
text_y = 430
# the screenshot had EBT more to the right; shift slightly
x = (W - text_width) / 2 + 70
d.text((x, text_y), text, font=font_big, fill=(14, 74, 107, 255))

d.text((500, 650), 'EB Meter', font=font_small, fill=(14, 74, 107, 255), anchor='mm')
d.text((500, 715), 'Tracker', font=font_small, fill=(14, 74, 107, 255), anchor='mm')

img.save('assets/icon.png')

# splash same design, centered
splash = Image.new('RGBA', (1242, 2208), (245, 245, 245, 255))
scaled = img.resize((920, 920))
splash.paste(scaled, (161, 440), scaled)
splash.save('assets/splash.png')

print('Created assets/icon.png and assets/splash.png')
