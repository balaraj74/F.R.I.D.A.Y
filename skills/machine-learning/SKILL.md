# Machine Learning

Assist with model training, data preparation, and evaluation for AI/ML tasks.

## Data Preparation

### Loading & Preprocessing
```python
import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler, LabelEncoder

# Load data
df = pd.read_csv("data.csv")

# Handle missing values
df.fillna(df.mean(), inplace=True)  # Numeric
df.fillna(df.mode().iloc[0], inplace=True)  # Categorical
df.dropna(inplace=True)  # Drop rows

# Encode categorical
le = LabelEncoder()
df['category_encoded'] = le.fit_transform(df['category'])

# One-hot encoding
df_encoded = pd.get_dummies(df, columns=['category'])

# Scale features
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X)

# Train/test split
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
```

## Model Training

### Classification
```python
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.svm import SVC

# Random Forest
rf = RandomForestClassifier(n_estimators=100, random_state=42)
rf.fit(X_train, y_train)
predictions = rf.predict(X_test)

# Logistic Regression
lr = LogisticRegression(max_iter=1000)
lr.fit(X_train, y_train)

# SVM
svm = SVC(kernel='rbf')
svm.fit(X_train, y_train)
```

### Regression
```python
from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
from sklearn.linear_model import LinearRegression, Ridge, Lasso

# Linear Regression
lr = LinearRegression()
lr.fit(X_train, y_train)

# Random Forest Regressor
rf = RandomForestRegressor(n_estimators=100)
rf.fit(X_train, y_train)

# Gradient Boosting
gb = GradientBoostingRegressor(n_estimators=100, learning_rate=0.1)
gb.fit(X_train, y_train)
```

### Deep Learning (PyTorch)
```python
import torch
import torch.nn as nn
import torch.optim as optim

class NeuralNet(nn.Module):
    def __init__(self, input_size, hidden_size, output_size):
        super().__init__()
        self.fc1 = nn.Linear(input_size, hidden_size)
        self.relu = nn.ReLU()
        self.fc2 = nn.Linear(hidden_size, output_size)
    
    def forward(self, x):
        return self.fc2(self.relu(self.fc1(x)))

model = NeuralNet(10, 64, 2)
criterion = nn.CrossEntropyLoss()
optimizer = optim.Adam(model.parameters(), lr=0.001)

# Training loop
for epoch in range(100):
    outputs = model(X_train_tensor)
    loss = criterion(outputs, y_train_tensor)
    optimizer.zero_grad()
    loss.backward()
    optimizer.step()
```

## Model Evaluation

### Metrics
```python
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score, f1_score,
    confusion_matrix, classification_report,
    mean_squared_error, mean_absolute_error, r2_score
)

# Classification metrics
print(f"Accuracy: {accuracy_score(y_test, predictions):.4f}")
print(f"Precision: {precision_score(y_test, predictions, average='weighted'):.4f}")
print(f"Recall: {recall_score(y_test, predictions, average='weighted'):.4f}")
print(f"F1 Score: {f1_score(y_test, predictions, average='weighted'):.4f}")
print(classification_report(y_test, predictions))

# Regression metrics
print(f"MSE: {mean_squared_error(y_test, predictions):.4f}")
print(f"RMSE: {np.sqrt(mean_squared_error(y_test, predictions)):.4f}")
print(f"MAE: {mean_absolute_error(y_test, predictions):.4f}")
print(f"R²: {r2_score(y_test, predictions):.4f}")
```

### Cross-Validation
```python
from sklearn.model_selection import cross_val_score, GridSearchCV

# Cross validation
scores = cross_val_score(model, X, y, cv=5, scoring='accuracy')
print(f"CV Scores: {scores}")
print(f"Mean: {scores.mean():.4f} (+/- {scores.std() * 2:.4f})")

# Hyperparameter tuning
param_grid = {'n_estimators': [50, 100, 200], 'max_depth': [3, 5, 10, None]}
grid_search = GridSearchCV(RandomForestClassifier(), param_grid, cv=5)
grid_search.fit(X_train, y_train)
print(f"Best params: {grid_search.best_params_}")
```

## Model Persistence

```python
import joblib
import pickle

# Save model
joblib.dump(model, 'model.joblib')
# or
with open('model.pkl', 'wb') as f:
    pickle.dump(model, f)

# Load model
model = joblib.load('model.joblib')
# or
with open('model.pkl', 'rb') as f:
    model = pickle.load(f)
```

## Quick Training Script

```bash
python3 << 'EOF'
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report
import joblib

# Load and prepare data
df = pd.read_csv("data.csv")
X = df.drop('target', axis=1)
y = df['target']

# Split
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

# Train
model = RandomForestClassifier(n_estimators=100, random_state=42)
model.fit(X_train, y_train)

# Evaluate
predictions = model.predict(X_test)
print(f"Accuracy: {accuracy_score(y_test, predictions):.4f}")
print(classification_report(y_test, predictions))

# Save
joblib.dump(model, 'model.joblib')
print("Model saved to model.joblib")
EOF
```

## Hugging Face Transformers

```python
from transformers import pipeline

# Text classification
classifier = pipeline("sentiment-analysis")
result = classifier("I love this product!")

# Text generation
generator = pipeline("text-generation", model="gpt2")
result = generator("Once upon a time", max_length=50)

# Named Entity Recognition
ner = pipeline("ner")
result = ner("Apple is looking at buying UK startup for $1 billion")
```

## Tools Required
- Python 3.8+
- scikit-learn
- pandas, numpy
- pytorch or tensorflow
- transformers (Hugging Face)
- jupyter (optional)

## Installation
```bash
pip install scikit-learn pandas numpy matplotlib seaborn
pip install torch torchvision  # PyTorch
pip install tensorflow  # TensorFlow
pip install transformers  # Hugging Face
pip install jupyter notebook
```
