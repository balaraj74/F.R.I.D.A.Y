# Data Analysis

Analyze data, automate reports, and create visualizations.

## Python Data Analysis

### Pandas Basics
```python
import pandas as pd
import numpy as np

# Load data
df = pd.read_csv("data.csv")
df = pd.read_excel("data.xlsx")
df = pd.read_json("data.json")

# Explore data
df.head()           # First 5 rows
df.info()           # Column types and nulls
df.describe()       # Statistics
df.shape            # (rows, cols)
df.columns          # Column names

# Filter and select
df[df['column'] > 100]
df[['col1', 'col2']]
df.query("age > 25 and city == 'NYC'")

# Group and aggregate
df.groupby('category')['value'].sum()
df.groupby(['cat1', 'cat2']).agg({'value': 'mean', 'count': 'sum'})

# Pivot tables
pd.pivot_table(df, values='sales', index='region', columns='product', aggfunc='sum')

# Save results
df.to_csv("output.csv", index=False)
df.to_excel("output.xlsx", index=False)
```

### Quick Analysis Script
```bash
python3 << 'EOF'
import pandas as pd
import sys

df = pd.read_csv(sys.argv[1] if len(sys.argv) > 1 else "data.csv")
print("=== Data Summary ===")
print(f"Rows: {len(df)}, Columns: {len(df.columns)}")
print(f"\nColumns: {list(df.columns)}")
print(f"\n{df.describe()}")
print(f"\nMissing values:\n{df.isnull().sum()}")
EOF
```

## Data Visualization

### Matplotlib/Seaborn
```python
import matplotlib.pyplot as plt
import seaborn as sns

# Line chart
plt.figure(figsize=(10, 6))
plt.plot(df['date'], df['value'])
plt.title('Trend Over Time')
plt.savefig('chart.png')

# Bar chart
df.groupby('category')['value'].sum().plot(kind='bar')
plt.savefig('bar_chart.png')

# Histogram
df['column'].hist(bins=20)
plt.savefig('histogram.png')

# Heatmap (correlation)
sns.heatmap(df.corr(), annot=True, cmap='coolwarm')
plt.savefig('correlation.png')

# Scatter plot
sns.scatterplot(data=df, x='col1', y='col2', hue='category')
plt.savefig('scatter.png')
```

### Quick Chart Script
```bash
python3 << 'EOF'
import pandas as pd
import matplotlib.pyplot as plt

df = pd.read_csv("data.csv")
df.plot(kind='line', x='date', y='value', figsize=(12, 6))
plt.title('Data Visualization')
plt.tight_layout()
plt.savefig('chart.png')
print("Chart saved to chart.png")
EOF
```

## Automated Reports

### Generate HTML Report
```python
import pandas as pd
from datetime import datetime

df = pd.read_csv("data.csv")

html = f"""
<!DOCTYPE html>
<html>
<head><title>Report - {datetime.now().strftime('%Y-%m-%d')}</title></head>
<body>
<h1>Data Report</h1>
<h2>Summary Statistics</h2>
{df.describe().to_html()}
<h2>Sample Data</h2>
{df.head(10).to_html()}
</body>
</html>
"""

with open("report.html", "w") as f:
    f.write(html)
```

### PDF Report with ReportLab
```python
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

c = canvas.Canvas("report.pdf", pagesize=letter)
c.drawString(100, 750, "Data Analysis Report")
c.drawString(100, 700, f"Total Records: {len(df)}")
c.save()
```

## Command Line Analysis

### CSV Analysis with csvkit
```bash
# Install csvkit
pip install csvkit

# View CSV structure
csvstat data.csv

# Query CSV with SQL
csvsql --query "SELECT category, SUM(value) FROM data GROUP BY category" data.csv

# Convert formats
in2csv data.xlsx > data.csv
csvjson data.csv > data.json

# Filter rows
csvgrep -c category -m "Electronics" data.csv
```

### Quick Stats with awk
```bash
# Sum column 3
awk -F',' '{sum+=$3} END {print "Sum:", sum}' data.csv

# Average
awk -F',' '{sum+=$3; count++} END {print "Avg:", sum/count}' data.csv

# Count unique values
awk -F',' '{a[$2]++} END {for(k in a) print k, a[k]}' data.csv
```

## Database Integration

### SQLite Analysis
```bash
# Query SQLite database
sqlite3 database.db "SELECT * FROM table LIMIT 10"

# Export to CSV
sqlite3 -header -csv database.db "SELECT * FROM table" > export.csv

# Run SQL file
sqlite3 database.db < queries.sql
```

### Python SQLite
```python
import sqlite3
import pandas as pd

conn = sqlite3.connect('database.db')
df = pd.read_sql_query("SELECT * FROM table WHERE condition", conn)
```

## Tools Required
- `python3` with pandas, numpy, matplotlib, seaborn
- `csvkit` - CSV utilities
- `sqlite3` - SQLite database
- `jq` - JSON processing

## Installation
```bash
pip install pandas numpy matplotlib seaborn openpyxl xlrd csvkit reportlab
sudo apt install -y sqlite3 jq
```
