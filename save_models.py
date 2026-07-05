"""
Run this script ONCE to generate .pkl files from your CSV datasets.
Place merged_student_dataset.csv and study_time_regression_dataset.csv
in the same directory, then run:
    python save_models.py
This will output all .pkl files into backend/ml_models/
"""
import os
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import LabelEncoder
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, mean_absolute_error, r2_score
import joblib

OUTPUT_DIR = "backend/ml_models"
os.makedirs(OUTPUT_DIR, exist_ok=True)

print("Loading datasets...")
weakness_df  = pd.read_csv("merged_student_dataset.csv")
studytime_df = pd.read_csv("study_time_regression_dataset.csv")

weakness_df  = weakness_df[["Subject","Topic","Exam_Score","Study_Time","Weakness_Label"]].dropna()
studytime_df = studytime_df[["Subject","Exam_Score","Weakness_Score","Topic_Difficulty","Recommended_Study_Hours"]].dropna()

print("Fitting encoders...")
le_subject  = LabelEncoder().fit(weakness_df["Subject"])
le_topic    = LabelEncoder().fit(weakness_df["Topic"])
le_subject2 = LabelEncoder().fit(studytime_df["Subject"])

weakness_df["Subject_Enc"]  = le_subject.transform(weakness_df["Subject"])
weakness_df["Topic_Enc"]    = le_topic.transform(weakness_df["Topic"])
studytime_df["Subject_Enc"] = le_subject2.transform(studytime_df["Subject"])

print("Training RandomForest weakness classifier...")
X1 = weakness_df[["Subject_Enc","Topic_Enc","Exam_Score","Study_Time"]]
y1 = weakness_df["Weakness_Label"]
X1_train, X1_test, y1_train, y1_test = train_test_split(X1, y1, test_size=0.2, random_state=42)
clf = RandomForestClassifier(n_estimators=100, random_state=42)
clf.fit(X1_train, y1_train)
acc = accuracy_score(y1_test, clf.predict(X1_test))
print(f"  Classifier accuracy: {acc:.0%}")

print("Training Linear Regression study-time predictor...")
X2 = studytime_df[["Subject_Enc","Exam_Score","Weakness_Score","Topic_Difficulty"]]
y2 = studytime_df["Recommended_Study_Hours"]
X2_train, X2_test, y2_train, y2_test = train_test_split(X2, y2, test_size=0.2, random_state=42)
reg = LinearRegression()
reg.fit(X2_train, y2_train)
mae = mean_absolute_error(y2_test, reg.predict(X2_test))
r2  = r2_score(y2_test, reg.predict(X2_test))
print(f"  Regression MAE: {mae:.2f} hrs  |  R²: {r2:.2%}")

print("Saving models...")
joblib.dump(clf,        f"{OUTPUT_DIR}/clf.pkl")
joblib.dump(reg,        f"{OUTPUT_DIR}/reg.pkl")
joblib.dump(le_subject, f"{OUTPUT_DIR}/le_subject.pkl")
joblib.dump(le_topic,   f"{OUTPUT_DIR}/le_topic.pkl")
joblib.dump(le_subject2,f"{OUTPUT_DIR}/le_subject2.pkl")

print(f"\nAll files saved to {OUTPUT_DIR}/")
print("Known subjects (classifier):", list(le_subject.classes_))
print("Known topics   (classifier):", list(le_topic.classes_))
print("Known subjects (regression):", list(le_subject2.classes_))
