# E-Commerce & Quick Commerce Control Skill

Control shopping apps and websites - browse, analyze, add to cart, and place orders.

## Supported Platforms

### Quick Commerce (Phone Apps)
| App | Package Name | Use For |
|-----|--------------|---------|
| **Blinkit** | `com.grofers.customerapp` | Groceries, essentials (10 min) |
| **Zepto** | `com.zeptoconsumerapp` | Groceries (10 min) |
| **Swiggy Instamart** | `in.swiggy.android` | Groceries, food |
| **BigBasket** | `com.bigbasket.mobileapp` | Groceries |
| **Dunzo** | `com.dunzo.user` | Anything delivery |

### E-Commerce (Phone Apps)
| App | Package Name | Use For |
|-----|--------------|---------|
| **Amazon** | `in.amazon.mShop.android.shopping` | Everything |
| **Flipkart** | `com.flipkart.android` | Electronics, fashion |
| **Myntra** | `com.myntra.android` | Fashion |
| **Meesho** | `com.meesho.supply` | Budget shopping |
| **Nykaa** | `com.fsn.nykaa` | Beauty, cosmetics |

### E-Commerce (Websites)
| Site | URL |
|------|-----|
| **Amazon** | https://amazon.in |
| **Flipkart** | https://flipkart.com |
| **Myntra** | https://myntra.com |
| **Ajio** | https://ajio.com |

---

## Phone App Commands

### Open Shopping Apps
```bash
# Quick Commerce
adb shell monkey -p com.grofers.customerapp -c android.intent.category.LAUNCHER 1  # Blinkit
adb shell monkey -p com.zeptoconsumerapp -c android.intent.category.LAUNCHER 1     # Zepto
adb shell monkey -p in.swiggy.android -c android.intent.category.LAUNCHER 1        # Swiggy

# E-Commerce
adb shell monkey -p in.amazon.mShop.android.shopping -c android.intent.category.LAUNCHER 1  # Amazon
adb shell monkey -p com.flipkart.android -c android.intent.category.LAUNCHER 1              # Flipkart
adb shell monkey -p com.myntra.android -c android.intent.category.LAUNCHER 1                # Myntra
```

### Search for Products
```bash
# Amazon - Search via deep link
adb shell am start -a android.intent.action.VIEW -d "https://www.amazon.in/s?k=SEARCH_TERM"

# Flipkart - Search via deep link
adb shell am start -a android.intent.action.VIEW -d "https://www.flipkart.com/search?q=SEARCH_TERM"

# Generic search in any app (type in search box)
adb shell input tap 540 150  # Tap search bar (adjust coordinates)
adb shell input text "SEARCH_TERM"
adb shell input keyevent KEYCODE_ENTER
```

### Navigate in Apps
```bash
# Go to cart
adb shell input tap 980 2200  # Cart icon (bottom right usually)

# Go back
adb shell input keyevent KEYCODE_BACK

# Scroll down to see more products
adb shell input swipe 540 1500 540 500 300

# Scroll up
adb shell input swipe 540 500 540 1500 300

# Tap on first product
adb shell input tap 540 600

# Add to cart (usually a button at bottom)
adb shell input tap 540 2100
```

### Quick Commerce Orders
```bash
# Blinkit - Order groceries
adb shell monkey -p com.grofers.customerapp -c android.intent.category.LAUNCHER 1
sleep 2
adb shell input tap 540 300  # Search
adb shell input text "milk"
adb shell input keyevent KEYCODE_ENTER

# Zepto - Quick order
adb shell monkey -p com.zeptoconsumerapp -c android.intent.category.LAUNCHER 1
sleep 2
adb shell input tap 540 200  # Search
adb shell input text "bread"
adb shell input keyevent KEYCODE_ENTER
```

---

## Browser Automation (Laptop)

### Open Shopping Sites
```bash
# Amazon
google-chrome "https://amazon.in" &

# Flipkart
google-chrome "https://flipkart.com" &

# Search on Amazon
google-chrome "https://www.amazon.in/s?k=wireless+earbuds" &

# Search on Flipkart
google-chrome "https://www.flipkart.com/search?q=laptop" &
```

### Price Comparison
```bash
# Open multiple sites for comparison
google-chrome "https://www.amazon.in/s?k=iphone+15" \
              "https://www.flipkart.com/search?q=iphone+15" \
              "https://www.croma.com/searchB?text=iphone+15" &
```

---

## Screenshot & Analysis

### Capture Product Screen
```bash
# Take screenshot of phone (product page)
adb shell screencap -p /sdcard/product.png
adb pull /sdcard/product.png ~/Pictures/product_$(date +%s).png
echo "Product screenshot saved to ~/Pictures/"

# Take screenshot of laptop browser
gnome-screenshot -f ~/Pictures/browser_$(date +%s).png
```

### View Product Details
```bash
# Get screen text (requires OCR - tesseract)
adb shell screencap -p /sdcard/screen.png
adb pull /sdcard/screen.png /tmp/screen.png
tesseract /tmp/screen.png /tmp/text
cat /tmp/text.txt
```

---

## Voice Commands Examples

| Say This | FRIDAY Does |
|----------|-------------|
| "Open Amazon on my phone" | Opens Amazon app |
| "Search for wireless earbuds on Flipkart" | Opens Flipkart with search |
| "Order milk from Blinkit" | Opens Blinkit, searches milk |
| "Compare iPhone prices" | Opens Amazon + Flipkart with iPhone search |
| "Take screenshot of this product" | Captures phone screen |
| "Add to cart" | Taps add to cart button |
| "Go to cart" | Navigates to cart |
| "What's in my Zepto cart?" | Opens Zepto cart |

---

## Smart Shopping Workflow

### 1. Product Research
```bash
# Step 1: Search on multiple platforms
google-chrome "https://amazon.in/s?k=PRODUCT" "https://flipkart.com/search?q=PRODUCT" &

# Step 2: Take screenshots for comparison
sleep 5
gnome-screenshot -f ~/Pictures/amazon_$(date +%s).png
```

### 2. Quick Grocery Order
```bash
# Open Blinkit
adb shell monkey -p com.grofers.customerapp -c android.intent.category.LAUNCHER 1
sleep 2

# Search for item
adb shell input tap 540 300
adb shell input text "eggs"
adb shell input keyevent KEYCODE_ENTER
sleep 2

# Tap first result
adb shell input tap 300 700

# Add to cart
adb shell input tap 540 2100
```

### 3. Order from Swiggy
```bash
# Open Swiggy
adb shell monkey -p in.swiggy.android -c android.intent.category.LAUNCHER 1
sleep 2

# Go to Instamart (usually top section)
adb shell input tap 300 400
sleep 2

# Search
adb shell input tap 540 200
adb shell input text "chips"
adb shell input keyevent KEYCODE_ENTER
```

---

## Package Names Reference

```bash
# Get all shopping apps installed
adb shell pm list packages | grep -iE "amazon|flipkart|myntra|swiggy|zepto|blinkit|grofers|bigbasket|meesho|nykaa|ajio|croma|reliance"
```

## Cart & Checkout Deep Links

```bash
# Amazon Cart
adb shell am start -a android.intent.action.VIEW -d "https://www.amazon.in/gp/cart/view.html"

# Flipkart Cart
adb shell am start -a android.intent.action.VIEW -d "https://www.flipkart.com/viewcart"
```

---

## Tips for FRIDAY

1. **Always wait 2-3 seconds** after opening an app before interacting
2. **Coordinates vary** by phone screen size - adjust tap coordinates
3. **Use deep links** when available for more reliable navigation
4. **Take screenshots** before important actions for verification
5. **Never auto-confirm payment** - always ask user to complete payment manually

## Safety Note
⚠️ FRIDAY should NEVER complete payments automatically. Always pause before final checkout and ask user to confirm.
