import { EmployerModel } from "../Schema_Models/EmployerModels.js";


export default async function EmployerForm(req, res) {
  try {
    const employerData = req.body;
    const newEmployer = new EmployerModel(employerData);
    await newEmployer.save();

    res.status(201).json({ message: 'Employer form submitted successfully!' });
  } catch (error) {
    console.error('Error submitting employer form:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

